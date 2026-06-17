/**
 * Unified integrations status (read-only aggregator).
 *
 *   GET /api/admin/integrations -> { integrations: IntegrationStatusItem[] }
 *
 * Admin-session-gated and read-rate-limited. Status is DERIVED at request time
 * (no status table). The payload carries ONLY booleans, enums, labels, and short
 * non-secret detail strings — never a key, token, or env value. Connect/test
 * write paths live under their own per-integration routes; this is reads only.
 */
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getIntegrationsStatus } from "@/lib/admin/integrations-status";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:integrations-status:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const integrations = await getIntegrationsStatus(session.organizationId);
    return successResponse({ integrations });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to read integrations status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
