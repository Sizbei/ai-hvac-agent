import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getConversations } from "@/lib/admin/conversation-queries";
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
      page,
      limit,
    });

    return successResponse({
      conversations: result.conversations,
      total: result.total,
      page,
      limit,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch admin conversations");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
