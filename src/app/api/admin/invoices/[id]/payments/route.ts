import { NextRequest, after } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { takePayment } from "@/lib/admin/invoice-queries";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { triggerPaymentReceipt } from "@/lib/communication/money-triggers";
import { processPendingJobs } from "@/lib/communication/job-queue";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

const takePaymentSchema = z.object({
  amountCents: z.number().int().min(1),
  isDeposit: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:invoice-payment:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      return errorResponse("Invalid ID", "VALIDATION_ERROR", 400);
    }
    const parsed = takePaymentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid payment", "VALIDATION_ERROR", 400);
    }

    const result = await takePayment(session.organizationId, id, {
      amountCents: parsed.data.amountCents,
      isDeposit: parsed.data.isDeposit,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "invoice_not_found":
          return errorResponse("Invoice not found", "NOT_FOUND", 404);
        case "invoice_not_chargeable":
          return errorResponse(
            "This invoice can no longer be charged",
            "INVOICE_NOT_CHARGEABLE",
            409,
          );
        case "synced_read_only":
          return errorResponse(
            "This invoice is synced from FieldPulse — manage payment in FieldPulse",
            "INVOICE_SYNCED_READ_ONLY",
            409,
          );
        case "charge_failed":
          return errorResponse("The charge was declined", "CHARGE_FAILED", 402);
        default:
          return errorResponse("Could not take payment", "VALIDATION_ERROR", 400);
      }
    }

    // cents + status enum only — no card data, no customer PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "payment_taken",
      entity: "invoice",
      entityId: id,
      details: `paymentId:${result.paymentId} amountCents:${parsed.data.amountCents} invoiceState:${result.invoiceState}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, invoiceId: id },
        "Failed to write audit log for payment",
      );
    });

    // Best-effort, non-blocking receipt. A comms failure must NEVER fail the
    // payment that already succeeded — so this runs in after() and swallows its
    // own errors. We enqueue a payment_receipt then drain immediately (Hobby's
    // daily cron is too slow for a receipt; after() survives the lambda freeze).
    const orgId = session.organizationId;
    const amountCents = parsed.data.amountCents;
    after(async () => {
      try {
        const [inv] = await db
          .select({ customerId: invoices.customerId })
          .from(invoices)
          .where(withTenant(invoices, orgId, eq(invoices.id, id)))
          .limit(1);
        if (!inv?.customerId) return;
        await triggerPaymentReceipt({
          organizationId: orgId,
          invoiceId: id,
          customerId: inv.customerId,
          amountCents,
        });
        await processPendingJobs();
      } catch (commsError) {
        logger.error(
          { error: commsError, invoiceId: id },
          "Payment receipt enqueue/drain failed (best-effort)",
        );
      }
    });

    return successResponse(
      { paymentId: result.paymentId, invoiceState: result.invoiceState },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to take payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
