import { getAdminSession } from "@/lib/auth/session";
import { getOpsInsights } from "@/lib/admin/ops-insights-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const insights = await getOpsInsights(session.organizationId);

    return successResponse(insights);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch operations insights");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
