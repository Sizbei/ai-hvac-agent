import type { NextRequest } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import { getAgenda } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/agenda?cursor=<opaque> — the chronological booking feed.
 *
 * The first page (no `cursor`) returns the newest bookings (all upcoming lead,
 * being newest). Pass a prior page's `nextCursor` back as `cursor` to load older
 * bookings (keyset pagination). Read-only; tenant-scoped via the session.
 */
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:agenda:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const cursor = request.nextUrl.searchParams.get("cursor");
    const page = await getAgenda(session.organizationId, cursor, viewer);
    return successResponse(page);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch agenda");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
