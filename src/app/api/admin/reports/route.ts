import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getSalesReport,
  getLeadSourceBreakdown,
  getLocationBreakdown,
  getTechnicianScorecards,
  type SalesReportPeriod,
} from "@/lib/admin/reporting-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Parse an ISO date param; returns undefined when absent, null when invalid. */
function parseDateParam(value: string | null): Date | null | undefined {
  if (value === null) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:reports:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { searchParams } = new URL(request.url);
    const fromDate = parseDateParam(searchParams.get("from"));
    const toDate = parseDateParam(searchParams.get("to"));

    if (fromDate === null || toDate === null) {
      return errorResponse("Invalid date range", "VALIDATION_ERROR", 400);
    }
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      return errorResponse(
        "`from` must be before `to`",
        "VALIDATION_ERROR",
        400,
      );
    }

    const period: SalesReportPeriod = { fromDate, toDate };
    const [
      report,
      leadSourceBreakdown,
      locationBreakdown,
      technicianScorecards,
    ] = await Promise.all([
      getSalesReport(session.organizationId, period),
      getLeadSourceBreakdown(session.organizationId, period),
      getLocationBreakdown(session.organizationId, period),
      getTechnicianScorecards(session.organizationId, period),
    ]);
    return successResponse({
      report,
      leadSourceBreakdown,
      locationBreakdown,
      technicianScorecards,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to build sales report");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
