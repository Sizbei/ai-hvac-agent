/**
 * POST /api/admin/integrations/housecall/disconnect
 *
 * Disconnect an org's Housecall Pro account: clears the encrypted API key and
 * cached account info, flips connected=false. Keeps the row for reconnects.
 *
 * Admin-session-gated + rate-limited + audited. No-op-safe if not connected.
 */
import { getAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { disconnectHousecallConnection } from "@/lib/integrations/housecall-pro/connection-queries";

export async function POST(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:hcp-disconnect:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    await disconnectHousecallConnection(session.organizationId);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "housecall_pro_disconnected",
      entity: "housecall_pro_connection",
      entityId: session.organizationId,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError },
        "Failed to audit Housecall disconnect",
      );
    });

    return successResponse({ connected: false });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to disconnect Housecall Pro");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
