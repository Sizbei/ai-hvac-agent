import { getAdminSession } from "@/lib/auth/session";
import { getBotAnalytics } from "@/lib/admin/bot-analytics-queries";
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
      `admin:bot-analytics:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const analytics = await getBotAnalytics(session.organizationId);

    return successResponse(analytics);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch bot analytics");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
