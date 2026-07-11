import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listReviews, getReviewStats } from "@/lib/reviews/review-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
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

    const sp = request.nextUrl.searchParams;
    const rawPage = Number(sp.get('page') ?? '1');
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const rawLimit = Number(sp.get('limit') ?? '50');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 20000) : 50;

    const [{ reviews, total }, stats] = await Promise.all([
      listReviews(session.organizationId, { page, limit }),
      getReviewStats(session.organizationId),
    ]);

    return successResponse({ reviews, total, stats });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load reviews");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
