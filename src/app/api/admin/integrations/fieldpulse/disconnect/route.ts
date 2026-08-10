/**
 * POST /api/admin/integrations/fieldpulse/disconnect
 *
 * Disconnect an org's Fieldpulse account: clear credentials, set connected=false,
 * and audit the action. The row is preserved for audit trail; all secrets are wiped.
 *
 * Super_admin-gated (Gsettings-2: disconnecting can silently stop the org's
 * CRM sync) + rate-limited + audited.
 */
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { deleteFieldpulseConnection } from "@/lib/integrations/fieldpulse/connection-queries";

export async function POST(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-disconnect:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    await deleteFieldpulseConnection(session.organizationId);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "fieldpulse_disconnected",
      entity: "fieldpulse_connection",
      entityId: session.organizationId,
      details: JSON.stringify({ disconnected: true }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit Fieldpulse disconnect");
    });

    return successResponse({ connected: false });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to disconnect Fieldpulse");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
