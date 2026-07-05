import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getOperationsMetrics,
  type OperationsMetricsPeriod,
} from "@/lib/admin/operations-metrics-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Parse an ISO date param; returns undefined when absent, null when invalid. */
function parseDateParam(value: string | null): Date | null | undefined {
  if (value === null) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/admin/operations-metrics?from&to
 *
 * The owner's operational scorecard: response time, days-to-paid + AR aging,
 * jobs booked, and dispatcher first-response — each with a period-over-period
 * trend. Admin-session gated, org-scoped, rate-limited.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:operations-metrics:${session.userId}`,
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
      return errorResponse("`from` must be before `to`", "VALIDATION_ERROR", 400);
    }

    const period: OperationsMetricsPeriod = { fromDate, toDate };
    const metrics = await getOperationsMetrics(session.organizationId, period);

    return successResponse(metrics);
  } catch (error) {
    logger.error({ error }, "Failed to load operations metrics");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
