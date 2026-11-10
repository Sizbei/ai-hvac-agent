import { NextRequest } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import { getConversations } from "@/lib/admin/conversation-queries";
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
      `admin:conversations-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const url = request.nextUrl;
    const status = url.searchParams.get("status") ?? undefined;
    const channel = url.searchParams.get("channel") ?? undefined;
    const search = url.searchParams.get("search") ?? undefined;
    const needsAction = url.searchParams.get("needsAction") === "1";
    const includeEmpty = url.searchParams.get("includeEmpty") === "1";
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20))
      : 20;

    const result = await getConversations(session.organizationId, {
      status,
      channel,
      search,
      needsAction,
      includeEmpty,
      page,
      limit,
    }, viewer);

    return successResponse({
      conversations: result.conversations,
      total: result.total,
      needsActionCount: result.needsActionCount,
      page,
      limit,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch admin conversations");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
