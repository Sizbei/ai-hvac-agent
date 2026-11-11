import { NextRequest } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import { listReviews, getReviewStats } from "@/lib/reviews/review-queries";
import { historyContactOrFallback } from "@/lib/admin/admin-guide-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

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
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;

    const reviewTextsOn = viewer.features.reviewRequests;
    const [{ reviews, total }, stats, historyContact] = await Promise.all([
      listReviews(session.organizationId, { page, limit }, viewer),
      getReviewStats(session.organizationId, viewer),
      reviewTextsOn ? null : historyContactOrFallback(session.organizationId),
    ]);

    // The page words its subtitle and empty state by the org's switch (P8 M9);
    // when off it names who can turn review texts on.
    return successResponse({
      reviews,
      total,
      stats,
      reviewTextsOn,
      historyContact,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load reviews");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
