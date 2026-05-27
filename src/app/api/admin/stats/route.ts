import { getAdminSession } from "@/lib/auth/session";
import { getDashboardStats } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const stats = await getDashboardStats(session.organizationId);
    return successResponse(stats);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch dashboard stats");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
