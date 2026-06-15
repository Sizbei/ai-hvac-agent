/**
 * Fieldpulse connection status.
 *
 *   GET — connection status for the settings panel (key-free).
 *
 * Admin-session-gated. The response includes a `configured` flag (true when an
 * env-fallback key is present even before an org connects) so the panel can
 * explain state precisely. NEVER returns the API key.
 */
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getFieldpulseConnectionStatus } from "@/lib/integrations/fieldpulse/connection-queries";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-status:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const status = await getFieldpulseConnectionStatus(session.organizationId);
    return successResponse({
      // An env fallback key means Fieldpulse is usable even before an explicit connect.
      configured:
        status.connected ||
        Boolean(process.env.FIELDPULSE_API_KEY?.trim()),
      connected: status.connected,
      accountInfo: status.accountInfo,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to read Fieldpulse status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
