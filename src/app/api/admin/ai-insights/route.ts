import { getAdminSession } from "@/lib/auth/session";
import { getAiInsights } from "@/lib/admin/ai-insights-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const insights = await getAiInsights(session.organizationId);

    return successResponse(insights);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch AI insights");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
