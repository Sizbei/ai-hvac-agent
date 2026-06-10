import { getAdminSession } from "@/lib/auth/session";
import { getAiInsights } from "@/lib/admin/ai-insights-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:ai-insights:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const insights = await getAiInsights(session.organizationId);

    return successResponse(insights);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch AI insights");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
