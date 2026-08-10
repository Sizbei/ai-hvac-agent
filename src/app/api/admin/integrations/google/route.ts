/**
 * Google Calendar connection status + disconnect.
 *
 *   GET    — connection status for the settings panel (token-free).
 *   DELETE — disconnect (clear stored tokens, flip connected=false).
 *
 * GET is admin-session-gated. DELETE is additionally super_admin-gated
 * (Gsettings-2: disconnecting can silently stop the org's calendar sync) +
 * rate-limited + audited. The GET response includes a `configured` flag so
 * the panel can explain a missing-credentials state.
 */
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getGoogleOAuthConfig } from "@/lib/integrations/google-calendar/oauth";
import {
  getGoogleConnectionStatus,
  disconnectGoogleConnection,
} from "@/lib/integrations/google-calendar/connection-queries";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const status = await getGoogleConnectionStatus(session.organizationId);
    return successResponse({
      configured: getGoogleOAuthConfig() !== null,
      connected: status.connected,
      calendarId: status.calendarId,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to read Google Calendar status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:gcal-disconnect:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    await disconnectGoogleConnection(session.organizationId);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "google_calendar_disconnected",
      entity: "google_calendar_connection",
    });

    return successResponse({ connected: false });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to disconnect Google Calendar");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
