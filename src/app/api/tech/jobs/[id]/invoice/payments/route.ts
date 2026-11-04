/**
 * POST /api/tech/jobs/[id]/invoice/payments — record a cash or check payment
 * on any non-void native invoice of the job (spec §6.2). Preamble → body →
 * key → idempotent run (any-target check, then the writer) → 201 when the
 * payment was created, 200 when the writer matched an existing one. Only a
 * fresh `created: true` sends the receipt (to the INVOICE's customer) and
 * drains the queue, both in after(), and audits `payment_recorded`.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { techWritePreamble, resolveTarget } from "@/lib/tech/invoice-route-guards";
import { reasonResult } from "@/lib/tech/invoice-errors";
import { auditWrite, okResult, readKey, readWriteBody, targetRefusal } from "@/lib/tech/invoice-write-route";
import { recordManualPayment } from "@/lib/admin/invoice-payment-writes";
import { triggerPaymentReceipt } from "@/lib/communication/money-triggers";
import { processPendingJobs } from "@/lib/communication/job-queue";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    invoiceId: z.string().uuid(),
    method: z.enum(["cash", "check"]),
    amountCents: z.number().int().min(1).max(100_000_000),
    checkNumber: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((b) => b.checkNumber === undefined || b.method === "check");

/** Receipt to the invoice's customer (an estimate-born invoice may differ from the request's); drain only when one was queued. */
async function sendReceipt(organizationId: string, invoiceId: string, amountCents: number): Promise<void> {
  try {
    const [inv] = await db
      .select({ customerId: invoices.customerId })
      .from(invoices)
      .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
      .limit(1);
    if (inv?.customerId) {
      await triggerPaymentReceipt({ organizationId, invoiceId, customerId: inv.customerId, amountCents });
      await processPendingJobs();
    }
  } catch (error) {
    logger.error({ error, invoiceId }, "Payment receipt enqueue/drain failed (best-effort)");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, bodySchema);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { invoiceId, method, amountCents, checkNumber } = body.data;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const target = await resolveTarget(organizationId, pre.requestId, invoiceId, "any");
        if (target !== "ok") return targetRefusal(target);
        const r = await recordManualPayment(
          { organizationId, requestId: pre.requestId, techUserId: userId },
          invoiceId,
          { paymentId: ids.id("payment") },
          { method, amountCents, checkNumber, isDeposit: false, recordedBy: userId },
        );
        if (!r.ok) return reasonResult(r.reason);
        return okResult(r.created ? 201 : 200, {
          paymentId: r.paymentId, invoiceId, invoiceState: r.invoiceState, created: r.created,
        });
      },
    );

    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      const { paymentId, invoiceState } = result.envelope.data as { paymentId: string; invoiceState: string };
      after(() => sendReceipt(organizationId, invoiceId, amountCents));
      await auditWrite({
        organizationId, userId, action: "payment_recorded", entity: "payment", entityId: paymentId,
        details: `paymentId:${paymentId} invoiceId:${invoiceId} method:${method} invoiceState:${invoiceState}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to record tech payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
