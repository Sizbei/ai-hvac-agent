import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listReviews, getReviewStats } from "@/lib/reviews/review-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET(_request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:reviews:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const [reviews, stats] = await Promise.all([
      listReviews(session.organizationId),
      getReviewStats(session.organizationId),
    ]);

    return successResponse({ reviews, stats });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load reviews");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
