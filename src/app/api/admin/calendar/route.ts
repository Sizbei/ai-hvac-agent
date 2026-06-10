import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getSchedulingCalendar, getMonthCalendar } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  businessWallClockToUtc,
  businessWeekDates,
  businessMonthDates,
  businessMonthOf,
  isRealIsoDate,
} from "@/lib/admin/calendar-time";
import { businessTodayIso } from "@/lib/admin/availability-queries";

/** The business-tz ISO date one day after `isoDate`. Whole-day stepping in UTC
 * is timezone-independent for calendar dates, so this is DST-safe. */
function nextIsoDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/admin/calendar?date=YYYY-MM-DD&view=day|week|month — the read-only
 * scheduling calendar.
 *
 * day/week return the full SchedulingCalendar (per-tech lanes + availability +
 * the unscheduled "to place" queue). month returns the lightweight MonthCalendar
 * (job chips bucketed by day, no lanes) — a read-only overview.
 *
 * `date` is a BUSINESS-timezone (America/New_York) calendar date; the instant
 * range we query is built from the first rendered day's business-tz midnight to
 * the midnight after the last rendered day, via calendar-time helpers so DST is
 * handled by the timezone db rather than fixed-offset math. We pass the rendered
 * business days to the query so the grid and the data agree on the span.
 */
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
    const view =
      viewParam === "week" || viewParam === "month" ? viewParam : "day";

    // Fall back to the business-tz "today" when the date is missing/invalid.
    // businessTodayIso derives Eastern's calendar date from the current instant
    // (not the UTC date), so between 8pm and midnight Eastern this still loads
    // TODAY — matching the client's Eastern "today" — instead of tomorrow's UTC
    // date.
    const date =
      dateParam && isRealIsoDate(dateParam)
        ? dateParam
        : businessTodayIso(new Date());

    const days =
      view === "month"
        ? businessMonthDates(date)
        : view === "week"
          ? businessWeekDates(date)
          : [date];

    // Half-open instant range: business-tz midnight of the first rendered day →
    // business-tz midnight of the day AFTER the last rendered day. nextIsoDate
    // steps the calendar date in UTC (timezone-independent for whole days), then
    // businessWallClockToUtc resolves each boundary's instant DST-correctly.
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const start = businessWallClockToUtc(firstDay, 0, 0);
    const end = businessWallClockToUtc(nextIsoDate(lastDay), 0, 0);

    if (view === "month") {
      const monthCalendar = await getMonthCalendar(
        session.organizationId,
        start.toISOString(),
        end.toISOString(),
        days,
        businessMonthOf(date),
      );
      return successResponse(monthCalendar);
    }

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
