import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getDispatchBoard } from "@/lib/admin/queries";
import { getDispatchExceptions } from "@/lib/admin/dispatch-exceptions-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/dispatch?date=YYYY-MM-DD — the dispatch board for a single
 * BUSINESS-timezone day: a column per active technician plus the unassigned
 * pile. The date param is optional (defaults to today) and validated downstream
 * in getDispatchBoard, which falls back to today for anything malformed.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:dispatch:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const date = request.nextUrl.searchParams.get("date") ?? undefined;
    const [board, exceptions] = await Promise.all([
      getDispatchBoard(session.organizationId, date),
      getDispatchExceptions(session.organizationId),
    ]);
    return successResponse({
      date: board.date,
      columns: board.columns,
      unassigned: board.unassigned,
      exceptions,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch dispatch board");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
