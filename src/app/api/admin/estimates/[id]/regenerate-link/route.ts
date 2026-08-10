import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { regenerateApprovalToken } from "@/lib/admin/estimate-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

/**
 * Mint a fresh one-time approval link for an open, native, unsynced estimate
 * — the recovery path once the create dialog's original link is dismissed.
 * The old plaintext token stops working the moment this succeeds (only the
 * newest token's hash is ever stored, see regenerateApprovalToken).
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:estimate-regenerate-link:${session.userId}`,
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

    const result = await regenerateApprovalToken(session.organizationId, id);
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return errorResponse("Estimate not found", "NOT_FOUND", 404);
        case "synced_read_only":
          return errorResponse(
            "This estimate is synced from FieldPulse — status is managed there",
            "SYNCED_READ_ONLY",
            409,
          );
        case "already_decided":
          return errorResponse(
            "This estimate has already been decided",
            "ALREADY_DECIDED",
            409,
          );
        default:
          return errorResponse("Could not create a new link", "VALIDATION_ERROR", 400);
      }
    }

    // entityId only — never the one-time token itself (bearer of authority).
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "estimate_link_regenerated",
      entity: "estimate",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, estimateId: id },
        "Failed to write audit log for estimate link regeneration",
      );
    });

    const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/estimates/${result.approvalToken}`;
    return successResponse({ approvalToken: result.approvalToken, approvalUrl });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to regenerate estimate approval link");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
