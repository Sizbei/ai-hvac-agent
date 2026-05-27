import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getRequests } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const url = request.nextUrl;
    const status = url.searchParams.get("status") ?? undefined;
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20))
      : 20;

    const result = await getRequests(session.organizationId, {
      status,
      page,
      limit,
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
