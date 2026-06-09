import { getAdminSession } from "@/lib/auth/session";
import { countUnscheduledRequests } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/calendar/unscheduled-count — the number of jobs still needing
 * to be placed on the calendar (no technician and/or no arrival window). Backs
 * the admin-nav notification badge; cheap COUNT(*), tenant-scoped.
 */
export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:unscheduled-count:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const count = await countUnscheduledRequests(session.organizationId);
    return successResponse({ count });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to count unscheduled requests");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
