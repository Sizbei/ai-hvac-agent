import { NextRequest } from "next/server";
import { z } from "zod";
import {
  resolvePortalToken,
  payPortalInvoice,
} from "@/lib/portal/portal-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// PUBLIC endpoint — authorized BY THE PORTAL TOKEN in the path, NOT an admin
// session. proxy.ts only session-gates /api/admin/*, so /api/portal/* passes
// through (it still receives the standard security headers).
//
// The customer sends ONLY an invoiceId + amountCents. org + customer come from
// resolving the token; payPortalInvoice re-verifies the invoice belongs to that
// (org, customer) before charging. amountCents is a positive int (cents).
const paySchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive().max(100_000_000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    const rateCheck = slidingWindow(`portal-pay:${ip}`, 10, 60_000);
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { token } = await params;
    const identity = await resolvePortalToken(token);
    if (!identity) {
      // Don't disclose whether the token is wrong vs. revoked.
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const parsed = paySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const result = await payPortalInvoice(
      identity.organizationId,
      identity.customerId,
      parsed.data.invoiceId,
      parsed.data.amountCents,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "invoice_not_found":
          // Includes the cross-customer / cross-tenant guard miss — collapse to
          // a generic 404 so an attacker can't probe invoice ownership.
          return errorResponse("Invoice not found", "NOT_FOUND", 404);
        case "invoice_not_chargeable":
        // A synced (FieldPulse/HCP) invoice is billed in the FSM, never payable
        // here — surface it the same as any other non-chargeable invoice.
        case "synced_read_only":
          return errorResponse(
            "This invoice can't be paid right now",
            "NOT_CHARGEABLE",
            409,
          );
        case "exceeds_balance":
          return errorResponse(
            "That amount is more than the invoice balance",
            "EXCEEDS_BALANCE",
            422,
          );
        case "charge_failed":
          return errorResponse(
            "The payment could not be completed",
            "CHARGE_FAILED",
            402,
          );
        default:
          // Never fall through to the success response on an unhandled rejection
          // reason — that would tell the customer "paid: true" for a payment that
          // did NOT happen.
          return errorResponse(
            "This invoice can't be paid right now",
            "NOT_CHARGEABLE",
            409,
          );
      }
    }

    // Audit (best-effort). A portal customer is NOT an admin user, so we insert
    // the row directly with user_id left NULL (a nullable FK to users) rather
    // than via logAudit, which requires a userId — same precedent as the HCP
    // webhook audit. actorType=system; details stay non-PII (ids + cents only).
    await db
      .insert(auditLog)
      .values({
        organizationId: identity.organizationId,
        actorType: "system",
        action: "portal_pay_invoice",
        entity: "invoice",
        entityId: parsed.data.invoiceId,
        details: JSON.stringify({
          customerId: identity.customerId,
        }),
        ipAddress: ip,
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Failed to audit portal payment");
      });

    return successResponse({ paid: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process portal payment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
