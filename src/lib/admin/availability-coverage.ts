/**
 * Availability coverage — pure helpers asking "is this window inside the
 * technician's working hours?" (Stage 4 conflict detection, half 2).
 *
 * A technician's availability is a set of recurring weekly windows
 * (technician_availability rows, see scheduling-queries.ts), each a [startMinute,
 * endMinute) span of minutes-from-midnight on a weekday (0=Sun…6=Sat), measured
 * in the BUSINESS timezone (America/New_York). A proposed arrival window is a
 * business-day (YYYY-MM-DD) + an ArrivalWindow row (morning/afternoon/evening).
 *
 * "Covered" means the proposed window's Eastern wall-clock span sits ENTIRELY
 * within the union of the tech's slots for that weekday — a job that starts
 * before the tech clocks in (or ends after they clock out) is out-of-hours.
 *
 * Pure: no I/O, no Date.now() — DST is handled by deriving the weekday from a
 * business-tz instant (calendar-time), so the same logic backs server-side
 * enforcement AND the client's out-of-hours shading without drifting.
 */
import type { AvailabilitySlot } from "./types";
import type { ArrivalWindow } from "./arrival-window";
import { arrivalWindowHours } from "./arrival-window";
import { businessWallClockToUtc, toBusinessWallClock } from "./calendar-time";

const MINUTES_PER_HOUR = 60;

/**
 * The business-timezone weekday (0=Sunday…6=Saturday) a calendar date falls on.
 * Resolved from the date's Eastern NOON instant so a DST-midnight edge can never
 * tip the weekday to the wrong day.
 */
export function businessWeekday(isoDay: string): number {
  const noonUtc = businessWallClockToUtc(isoDay, 12, 0);
  const wall = toBusinessWallClock(noonUtc);
  // Build a UTC instant from the wall-clock Y/M/D and read its UTC weekday —
  // the wall clock is already in the business zone, so getUTCDay is the
  // business weekday without any further offset math.
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/**
 * Is the [winStart, winEnd) wall-clock minute span fully covered by the union of
 * `slots` (each a [startMinute, endMinute) span)? Slots may be adjacent or
 * overlapping (split shifts like 8–12 and 13–17 are two rows); we merge them
 * before testing so a window spanning two touching shifts still counts as
 * covered, while a gap between shifts correctly leaves a window uncovered.
 */
function spanIsCovered(
  slots: readonly { readonly startMinute: number; readonly endMinute: number }[],
  winStart: number,
  winEnd: number,
): boolean {
  if (slots.length === 0) return false;
  // Walk the slots in start order, advancing a `cursor` that marks how far the
  // window is contiguously covered. A slot starting after the cursor leaves a
  // gap the window can't bridge → uncovered. Adjacent shifts (end == next.start)
  // extend the cursor with no gap, so split shifts that touch read as one span.
  const sorted = [...slots].sort((a, b) => a.startMinute - b.startMinute);
  let cursor = winStart;
  for (const slot of sorted) {
    if (slot.endMinute <= cursor) continue; // entirely before the covered part
    if (slot.startMinute > cursor) return false; // gap → window not fully covered
    cursor = slot.endMinute;
    if (cursor >= winEnd) return true;
  }
  return cursor >= winEnd;
}

/**
 * Does the technician's availability fully cover the proposed window on the
 * given business day? Slots are filtered to the day's weekday, then the window's
 * Eastern wall-clock hours are tested against their merged union.
 *
 * Returns `true` when the tech has NO availability defined for that weekday —
 * NO: that would silently allow everything. We return `false` (out of hours) so
 * an undefined schedule reads as "not working", which the caller surfaces as a
 * warning the dispatcher can override. (A tech with no hours configured at all
 * is the common pre-setup state; the override path keeps the board usable.)
 */
export function isWindowWithinAvailability(
  slots: readonly AvailabilitySlot[],
  isoDay: string,
  window: ArrivalWindow,
): boolean {
  const [startHour, endHour] = arrivalWindowHours(window);
  const winStart = startHour * MINUTES_PER_HOUR;
  const winEnd = endHour * MINUTES_PER_HOUR;
  const weekday = businessWeekday(isoDay);
  const daySlots = slots.filter((slot) => slot.dayOfWeek === weekday);
  return spanIsCovered(daySlots, winStart, winEnd);
}
