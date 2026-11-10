import { getViewerContext } from "@/lib/auth/viewer";
import { getAiInsights } from "@/lib/admin/ai-insights-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:ai-insights:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const insights = await getAiInsights(session.organizationId, viewer);

    return successResponse(insights);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch AI insights");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
