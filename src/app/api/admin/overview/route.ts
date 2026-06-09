import { getAdminSession } from "@/lib/auth/session";
import { getDashboardOverview } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/overview — one tenant-scoped payload for the admin dashboard
 * landing page: expanded KPI counts, today's arrival-window schedule, the
 * unassigned urgent/emergency queue, and on-hold requests awaiting follow-up.
 */
export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const overview = await getDashboardOverview(session.organizationId);
    return successResponse(overview);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch dashboard overview");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
