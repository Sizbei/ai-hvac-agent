import { getViewerContext } from "@/lib/auth/viewer";
import { getDashboardOverview } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/overview — one tenant-scoped payload for the admin dashboard
 * landing page: expanded KPI counts, today's arrival-window schedule, the
 * unassigned urgent/emergency queue, and on-hold requests awaiting follow-up.
 */
export async function GET() {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:overview:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const overview = await getDashboardOverview(session.organizationId, viewer);
    return successResponse(overview);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch dashboard overview");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
