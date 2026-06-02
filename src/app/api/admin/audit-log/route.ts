import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getAuditLog } from "@/lib/admin/audit-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const url = request.nextUrl;
    const action = url.searchParams.get("action") ?? undefined;
    const entity = url.searchParams.get("entity") ?? undefined;
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 50))
      : 50;

    const result = await getAuditLog(session.organizationId, {
      action,
      entity,
      page,
      limit,
    });

    return successResponse({
      entries: result.entries,
      total: result.total,
      actions: result.actions,
      page,
      limit,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch audit log");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
