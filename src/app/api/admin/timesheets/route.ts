/** GET /api/admin/timesheets?technicianId=&from=&to= — a technician's time entries (read-only). */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listTimesheetEntries } from "@/lib/admin/timesheet-admin-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { isRealIsoDate } from "@/lib/admin/calendar-time";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX_RANGE_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `admin:timesheets:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const technicianId = params.get("technicianId");
    const from = params.get("from");
    const to = params.get("to");
    if (!isUuid(technicianId)) {
      return errorResponse("Invalid technician.", "VALIDATION_ERROR", 400);
    }
    if (!from || !to || !isRealIsoDate(from) || !isRealIsoDate(to)) {
      return errorResponse("Enter a valid date range.", "VALIDATION_ERROR", 400);
    }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (days < 0) {
      return errorResponse("The start date must be on or before the end date.", "VALIDATION_ERROR", 400);
    }
    if (days + 1 > MAX_RANGE_DAYS) {
      return errorResponse("Choose a range of 92 days or less.", "VALIDATION_ERROR", 400);
    }

    const entries = await listTimesheetEntries(session.organizationId, technicianId, from, to);
    return successResponse({ entries });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list timesheet entries");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
