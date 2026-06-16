import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { takePayment } from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

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

    return successResponse(
      { paymentId: result.paymentId, invoiceState: result.invoiceState },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to take payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
