import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getSchedulingCalendar } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  businessWallClockToUtc,
  businessWeekDates,
} from "@/lib/admin/calendar-time";

/**
 * GET /api/admin/calendar?date=YYYY-MM-DD&view=day|week — the read-only
 * scheduling calendar for a day or week, plus the unscheduled "to place" queue.
 *
 * `date` is a BUSINESS-timezone (America/New_York) calendar date; the instant
 * range we query is built from that day's business-tz midnight to the midnight
 * after the last day in view, via calendar-time helpers so DST is handled by the
 * timezone db rather than fixed-offset math. We pass the rendered business days
 * to the query so the grid and the data agree on the span.
 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:calendar:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const dateParam = request.nextUrl.searchParams.get("date");
    const viewParam = request.nextUrl.searchParams.get("view") ?? "day";
    const view = viewParam === "week" ? "week" : "day";

    // Fall back to the business-tz "today" when the date is missing/invalid.
    const date =
      dateParam && isIsoDate(dateParam)
        ? dateParam
        : new Date().toISOString().slice(0, 10);

    const days =
      view === "week" ? businessWeekDates(date) : [date];

    // Half-open instant range: business-tz midnight of the first day → midnight
    // after the last day. DST-correct via businessWallClockToUtc.
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const start = businessWallClockToUtc(firstDay, 0, 0);
    // End = start of the day after the last rendered day.
    const lastDayMidnight = businessWallClockToUtc(lastDay, 0, 0);
    const end = businessWallClockToUtc(
      new Date(lastDayMidnight.getTime() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      0,
      0,
    );

    const calendar = await getSchedulingCalendar(
      session.organizationId,
      start.toISOString(),
      end.toISOString(),
      days,
    );
    return successResponse(calendar);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch scheduling calendar");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
