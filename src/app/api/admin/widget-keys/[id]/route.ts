import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { revokeWidgetKey } from "@/lib/widget/key-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revoke (deactivate) a key. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:widget-keys-revoke:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid key ID", "INVALID_ID", 400);
    }

    const revoked = await revokeWidgetKey(session.organizationId, id);
    if (!revoked) {
      return errorResponse("Key not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "revoke_widget_key",
      entity: "widget_keys",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit key revocation");
    });

    return successResponse({ revoked: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to revoke widget key");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
