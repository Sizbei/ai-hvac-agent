import { NextRequest } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import { getCachedHistoryCutoff } from "@/lib/tenancy/features";
import { getAuditLog } from "@/lib/admin/audit-queries";
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
      `admin:audit-log-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
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

    // Org viewers see entries from the go-live moment on, minus the sync
    // entries of hidden invoices; the platform admin (not previewing) and orgs
    // with showHistory see everything. A failed cutoff read throws to the 500
    // below, and a malformed cutoff lists nothing, rather than showing all history.
    const since = viewer.showHidden
      ? undefined
      : ((await getCachedHistoryCutoff(session.organizationId)) ?? undefined);

    const result = await getAuditLog(session.organizationId, {
      action,
      entity,
      page,
      limit,
      since,
      visibleOnly: !viewer.showHidden,
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
