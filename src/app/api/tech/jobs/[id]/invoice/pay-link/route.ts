/**
 * POST /api/tech/jobs/[id]/invoice/pay-link — text the customer the portal
 * link for this job's invoice (spec §6.4). Preamble → body → key → idempotent
 * run (target check, then sendInvoicePayLink). The queue drains in after()
 * only on a fresh 200 (Hobby's cron is daily); a replay drains and audits
 * nothing. SEND_FAILED is stored: the message may already have gone out.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { readJsonBody, errorResponse } from "@/lib/api-response";
import { techWritePreamble, resolveTarget } from "@/lib/tech/invoice-route-guards";
import { reasonResult } from "@/lib/tech/invoice-errors";
import { canonicalHash, parseIdempotencyKey, toResponse, withIdempotency, type RunResult } from "@/lib/http/idempotency";
import { sendInvoicePayLink } from "@/lib/communication/money-triggers";
import { processPendingJobs } from "@/lib/communication/job-queue";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ invoiceId: z.string().uuid() });

const SEND_FAILED: RunResult = {
  status: 500,
  envelope: { success: false, error: { message: "The link may not have gone out. Try again in 2 minutes.", code: "SEND_FAILED" } },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? bodySchema.safeParse(raw.data) : null;
    if (!parsed?.success) return errorResponse("Check the invoice and try again.", "INVALID_INPUT", 400);
    const { invoiceId } = parsed.data;

    const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
    if (!key) return errorResponse("Missing idempotency key.", "IDEMPOTENCY_KEY_REQUIRED", 400);

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key },
      canonicalHash(parsed.data),
      async () => {
        const target = await resolveTarget(organizationId, pre.requestId, invoiceId, "any");
        if (target !== "ok") return reasonResult(target === "stale" ? "stale" : "invoice_not_found");
        const sent = await sendInvoicePayLink(organizationId, invoiceId);
        if (!sent.ok) return sent.reason === "send_failed" ? SEND_FAILED : reasonResult(sent.reason);
        return { status: 200, envelope: { success: true, data: { queued: true } } };
      },
    );

    if (result.status === 200 && !result.replayed) {
      after(async () => {
        try {
          await processPendingJobs();
        } catch (error) {
          logger.error({ error, invoiceId }, "Pay link queue drain failed");
        }
      });
      try {
        await logAudit({
          organizationId,
          userId,
          action: "pay_link_sent",
          entity: "invoice",
          entityId: invoiceId,
          details: `invoiceId:${invoiceId}`,
        });
      } catch (error) {
        logger.error({ error, invoiceId }, "Pay link audit failed");
      }
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to send pay link");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
