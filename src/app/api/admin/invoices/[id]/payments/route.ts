import { NextRequest, after } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { takePayment } from "@/lib/admin/invoice-queries";
import { recordManualPayment } from "@/lib/admin/invoice-payment-writes";
import { cardPaymentsEnabled } from "@/lib/payments/card-enabled";
import { officeId } from "@/lib/http/idempotency";
import { fieldError } from "@/lib/tech/invoice-errors";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { triggerPaymentReceipt } from "@/lib/communication/money-triggers";
import { processPendingJobs } from "@/lib/communication/job-queue";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

/** A check number is letters, digits and dashes only: never free text (erase never clears it). */
const CHECK_NUMBER = /^[A-Za-z0-9-]{1,32}$/;

const recordPaymentSchema = z
  .object({
    clientToken: z.string().uuid(),
    method: z.enum(["card", "cash", "check", "other"]),
    amountCents: z.number().int().min(1).max(100_000_000),
    checkNumber: z.string().trim().min(1).max(32).regex(CHECK_NUMBER).optional(),
    isDeposit: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.checkNumber === undefined || b.method === "check", {
    path: ["checkNumber"],
  });

type Recorded = { paymentId: string; invoiceState: string; created: boolean };
type Refusal = { status: number; code: string; message: string };

/** Office copy for the manual-payment refusals (spec §6.3 codes; §8 copy). */
function manualRefusal(reason: Parameters<typeof fieldError>[0]): Refusal {
  switch (reason) {
    case "invoice_not_found":
      return { status: 404, code: "NOT_FOUND", message: "Invoice not found" };
    case "invoice_not_chargeable":
      return { status: 409, code: "INVOICE_NOT_CHARGEABLE", message: "Finalize the invoice first." };
    case "stale":
      return { status: 409, code: "STALE", message: "This invoice changed. Refresh and try again." };
    case "synced_read_only":
    case "exceeds_balance":
    case "payment_id_conflict":
      return fieldError(reason);
    default:
      return { status: 400, code: "VALIDATION_ERROR", message: "Could not record payment" };
  }
}

function cardRefusal(reason: string): Refusal {
  switch (reason) {
    case "invoice_not_found":
      return { status: 404, code: "NOT_FOUND", message: "Invoice not found" };
    case "invoice_not_chargeable":
      return { status: 409, code: "INVOICE_NOT_CHARGEABLE", message: "This invoice can no longer be charged" };
    case "synced_read_only":
      return fieldError("synced_read_only");
    case "charge_failed":
      return { status: 402, code: "CHARGE_FAILED", message: "The charge was declined" };
    default:
      return { status: 400, code: "VALIDATION_ERROR", message: "Could not take payment" };
  }
}

/** The invoice's customer for the receipt; a read failure skips the receipt, never the 201. */
async function invoiceCustomerId(orgId: string, invoiceId: string): Promise<string | null> {
  try {
    const [inv] = await db
      .select({ customerId: invoices.customerId })
      .from(invoices)
      .where(withTenant(invoices, orgId, eq(invoices.id, invoiceId)))
      .limit(1);
    return inv?.customerId ?? null;
  } catch (error) {
    logger.error({ error, invoiceId }, "Payment receipt customer lookup failed (best-effort)");
    return null;
  }
}

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
    const body = await readJsonBody(request);
    const parsed = body.ok ? recordPaymentSchema.safeParse(body.data) : null;
    if (!parsed?.success) {
      return errorResponse("Invalid payment", "VALIDATION_ERROR", 400);
    }
    const { clientToken, method, amountCents, checkNumber, isDeposit } = parsed.data;
    const orgId = session.organizationId;

    let recorded: Recorded;
    if (method === "card") {
      if (!cardPaymentsEnabled()) {
        return errorResponse("Online payment isn't available yet.", "CARD_PAYMENTS_UNAVAILABLE", 409);
      }
      const result = await takePayment(orgId, id, { amountCents, isDeposit });
      if (!result.ok) {
        const r = cardRefusal(result.reason);
        return errorResponse(r.message, r.code, r.status);
      }
      recorded = { paymentId: result.paymentId, invoiceState: result.invoiceState, created: true };
    } else {
      const result = await recordManualPayment(
        { organizationId: orgId, requestId: null, techUserId: null },
        id,
        { paymentId: officeId("payment", orgId, clientToken) },
        { method, amountCents, checkNumber, isDeposit: !!isDeposit, recordedBy: session.userId },
      );
      if (!result.ok) {
        const r = manualRefusal(result.reason);
        return errorResponse(r.message, r.code, r.status);
      }
      recorded = { paymentId: result.paymentId, invoiceState: result.invoiceState, created: result.created };
    }

    // A replay (created: false) already audited and sent its receipt.
    if (!recorded.created) {
      return successResponse(recorded, 200);
    }

    // ids/enums only — no money values or check numbers in audit details.
    await logAudit({
      organizationId: orgId,
      userId: session.userId,
      action: "payment_recorded",
      entity: "invoice",
      entityId: id,
      details: `paymentId:${recorded.paymentId} invoiceId:${id} method:${method} invoiceState:${recorded.invoiceState}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, invoiceId: id },
        "Failed to write audit log for payment",
      );
    });

    // Best-effort, non-blocking receipt — only when the invoice has a customer,
    // so nothing drains the queue unless something was queued. A comms failure
    // must NEVER fail the payment; the drain is mandatory (Hobby's cron is daily).
    const customerId = await invoiceCustomerId(orgId, id);
    if (customerId) {
      after(async () => {
        try {
          await triggerPaymentReceipt({ organizationId: orgId, invoiceId: id, customerId, amountCents });
          await processPendingJobs();
        } catch (commsError) {
          logger.error(
            { error: commsError, invoiceId: id },
            "Payment receipt enqueue/drain failed (best-effort)",
          );
        }
      });
    }

    return successResponse(recorded, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to record payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
