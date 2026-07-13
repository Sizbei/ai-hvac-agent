import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getRequests } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import type { RequestSortKey } from "@/lib/admin/types";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:requests-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const url = request.nextUrl;
    const status = url.searchParams.get("status") ?? undefined;
    const searchParam = url.searchParams.get("search") ?? undefined;
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");
    const urgency = url.searchParams.get("urgency") ?? undefined;
    const assignedTo = url.searchParams.get("assignedTo") ?? undefined;
    const isAfterHoursParam = url.searchParams.get("isAfterHours");
    const sortParam = url.searchParams.get("sort") ?? undefined;

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 50))
      : 50;

    // Cap the search term defensively; it can't usefully exceed a 20-char
    // reference number anyway.
    const search = searchParam ? searchParam.slice(0, 64) : undefined;
    const isAfterHours = isAfterHoursParam === "true" ? true : undefined;
    const VALID_SORTS: readonly string[] = ['newest', 'oldest', 'urgency'];
    const sort = (sortParam !== undefined && VALID_SORTS.includes(sortParam)
      ? sortParam
      : undefined) as RequestSortKey | undefined;

    const result = await getRequests(session.organizationId, {
      status,
      search,
      page,
      limit,
      urgency,
      assignedTo,
      isAfterHours,
      sort,
    });

    return successResponse({
      requests: result.requests,
      total: result.total,
      page,
      limit,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch admin requests");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
