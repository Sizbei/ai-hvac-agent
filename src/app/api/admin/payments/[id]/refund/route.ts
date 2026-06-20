import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { refundPayment } from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Structured reason (a fixed enum) — NOT free text — so no unencrypted PII can
// land in the refunds table or the audit log.
const refundSchema = z.object({
  amountCents: z.number().int().min(1),
  reason: z.enum(["duplicate", "customer_request", "defective", "other"]),
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

    // Money OUT requires super_admin. The route is the hard gate regardless of
    // any client-side hiding of the refund control.
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:payment-refund:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const parsed = refundSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid refund", "VALIDATION_ERROR", 400);
    }

    const result = await refundPayment(session.organizationId, id, {
      amountCents: parsed.data.amountCents,
      reason: parsed.data.reason,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "payment_not_found":
          return errorResponse("Payment not found", "NOT_FOUND", 404);
        case "not_refundable":
          return errorResponse(
            "This payment cannot be refunded",
            "NOT_REFUNDABLE",
            409,
          );
        case "exceeds_payment":
          return errorResponse(
            "The refund exceeds the payment's remaining balance",
            "EXCEEDS_PAYMENT",
            422,
          );
        case "synced_read_only":
          return errorResponse(
            "This invoice is synced from FieldPulse — manage refunds in FieldPulse",
            "INVOICE_SYNCED_READ_ONLY",
            409,
          );
        default:
          return errorResponse("Could not refund payment", "VALIDATION_ERROR", 400);
      }
    }

    // cents + reason ENUM only — the enum carries no PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "payment_refunded",
      entity: "payment",
      entityId: id,
      details: `refundId:${result.refundId} amountCents:${parsed.data.amountCents} reason:${parsed.data.reason}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, paymentId: id },
        "Failed to write audit log for refund",
      );
    });

    return successResponse({ refundId: result.refundId }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to refund payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
