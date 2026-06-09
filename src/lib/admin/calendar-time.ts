/**
 * Calendar time math — UTC instants ↔ business-timezone slot positions.
 *
 * Everything in the system is STORED and computed in UTC (arrival windows are
 * UTC-anchored, see arrival-window.ts). The scheduling calendar, however, must
 * RENDER in the fixed business timezone — America/New_York — never the viewer's
 * browser zone. A dispatcher in Denver and one in Boston must see the same grid.
 *
 * The hard part is DST. New York is UTC-5 in winter (EST) and UTC-4 in summer
 * (EDT). A naive "subtract 5 hours" would place a July job an hour off and would
 * mis-handle the two days a year that are 23h or 25h long. So we NEVER do
 * fixed-minute offset math: we derive the wall-clock parts of a real instant via
 * Intl.DateTimeFormat with timeZone, and we derive the UTC instant for a given
 * wall-clock time by probing the actual offset at that instant. Both directions
 * are computed from real Date instants, so DST is handled by the platform's
 * timezone database rather than by hand.
 *
 * Pure module: no I/O, no Date.now(), no window access — safe to unit-test and
 * to import into client components without an SSR hydration risk.
 */
import {
  type ArrivalWindow,
  arrivalWindowHours,
} from "./arrival-window";

/** The single business timezone the calendar renders in. Eastern (handles DST). */
export const BUSINESS_TIME_ZONE = "America/New_York";

/** Default business-hours grid: 7am–8pm Eastern, the rows the calendar draws. */
export const CALENDAR_START_HOUR = 7;
export const CALENDAR_END_HOUR = 20;

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;

/** Wall-clock parts of an instant, as observed in the business timezone. */
export interface BusinessWallClock {
  readonly year: number;
  /** 1–12 (calendar month, not JS 0-based). */
  readonly month: number;
  readonly day: number;
  /** 0–23. */
  readonly hour: number;
  readonly minute: number;
}

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The wall-clock time a UTC instant shows on a clock in the business timezone.
 * e.g. 2026-07-01T16:30:00Z (summer, EDT = UTC-4) → 12:30 on July 1.
 */
export function toBusinessWallClock(instant: Date): BusinessWallClock {
  const parts = PARTS_FORMATTER.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // Intl renders midnight as hour "24" under h23 in some engines; normalise.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };
}

/**
 * The UTC offset (in minutes, e.g. -300 for EST, -240 for EDT) in effect in the
 * business timezone AT a given instant. Derived by formatting the instant in the
 * zone and comparing the resulting wall clock to the same parts read as UTC — a
 * real-instant probe, so it is always the correct offset for that moment incl.
 * across a DST boundary.
 */
export function businessOffsetMinutes(instant: Date): number {
  const wall = toBusinessWallClock(instant);
  // Treat the observed wall-clock parts as if they were UTC, then diff against
  // the true instant. The difference is the zone's offset at that instant.
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  // Round to the minute: the instant may carry seconds the wall clock dropped.
  const instantMinutes = Math.floor(instant.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return Math.round((asUtc - instantMinutes) / MS_PER_MINUTE);
}

/**
 * The UTC instant for a wall-clock time in the business timezone on a given day.
 * Inverse of toBusinessWallClock. DST-correct: we make a first guess using the
 * offset that applies at the day's UTC midnight, then re-probe the offset at the
 * guessed instant and correct once — which resolves the case where the guess and
 * the target land on opposite sides of a DST transition.
 *
 * `isoDate` is the business-day date (YYYY-MM-DD); hour/minute are wall-clock.
 */
export function businessWallClockToUtc(
  isoDate: string,
  hour: number,
  minute: number,
): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  // First guess: interpret the wall time as UTC, then shift by the offset that
  // applies around the start of that calendar day.
  const naiveUtcMs = Date.UTC(y, m - 1, d, hour, minute);
  const dayMidnightOffset = businessOffsetMinutes(new Date(naiveUtcMs));
  const guessMs = naiveUtcMs - dayMidnightOffset * MS_PER_MINUTE;
  // Re-probe at the guess; if the offset differs (we crossed a DST boundary),
  // correct by the delta. One correction suffices for a single 1h transition.
  const guessOffset = businessOffsetMinutes(new Date(guessMs));
  if (guessOffset === dayMidnightOffset) {
    return new Date(guessMs);
  }
  return new Date(naiveUtcMs - guessOffset * MS_PER_MINUTE);
}

/** Minutes from midnight (business-tz wall clock) for an instant. 0–1439. */
export function businessMinutesOfDay(instant: Date): number {
  const wall = toBusinessWallClock(instant);
  return wall.hour * MINUTES_PER_HOUR + wall.minute;
}

/** The business-timezone calendar date (YYYY-MM-DD) an instant falls on. */
export function businessIsoDate(instant: Date): string {
  const wall = toBusinessWallClock(instant);
  const mm = String(wall.month).padStart(2, "0");
  const dd = String(wall.day).padStart(2, "0");
  return `${wall.year}-${mm}-${dd}`;
}

/**
 * Vertical placement of a job in a day column, as a fraction of the visible
 * grid. The grid spans [gridStartHour, gridEndHour) wall-clock hours; a job's
 * `top`/`height` are fractions in [0, 1] of that span, clamped so a window that
 * starts before the grid opens or ends after it closes still renders inside the
 * column. Returns null when the job lies entirely outside the visible hours.
 *
 * Position is computed from the REAL instants' business-tz minutes (DST-correct),
 * not from fixed-offset arithmetic.
 */
export interface SlotPlacement {
  /** Fraction [0,1] from the top of the grid where the job starts. */
  readonly top: number;
  /** Fraction (0,1] of the grid height the job occupies. */
  readonly height: number;
}

export function placeJobInGrid(
  startInstant: Date,
  endInstant: Date,
  gridStartHour: number = CALENDAR_START_HOUR,
  gridEndHour: number = CALENDAR_END_HOUR,
): SlotPlacement | null {
  const gridStartMin = gridStartHour * MINUTES_PER_HOUR;
  const gridEndMin = gridEndHour * MINUTES_PER_HOUR;
  const span = gridEndMin - gridStartMin;
  if (span <= 0) return null;

  const startMin = businessMinutesOfDay(startInstant);
  // End on the same business day may roll past midnight; clamp to grid end so a
  // window like 16–20 places correctly even if math rounds at the boundary.
  let endMin = businessMinutesOfDay(endInstant);
  // If end appears earlier than start (crossed midnight), treat as end-of-day.
  if (endMin <= startMin) endMin = gridEndMin;

  // Entirely outside the visible window → no placement.
  if (endMin <= gridStartMin || startMin >= gridEndMin) return null;

  const clampedStart = Math.max(startMin, gridStartMin);
  const clampedEnd = Math.min(endMin, gridEndMin);

  return {
    top: (clampedStart - gridStartMin) / span,
    height: (clampedEnd - clampedStart) / span,
  };
}

/** Hour-row labels for the grid, e.g. ["7 AM", "8 AM", … "7 PM"]. */
export function hourRowLabels(
  gridStartHour: number = CALENDAR_START_HOUR,
  gridEndHour: number = CALENDAR_END_HOUR,
): readonly string[] {
  const labels: string[] = [];
  for (let h = gridStartHour; h < gridEndHour; h += 1) {
    const period = h < 12 ? "AM" : "PM";
    const display = h % 12 === 0 ? 12 : h % 12;
    labels.push(`${display} ${period}`);
  }
  return labels;
}

/**
 * Format a UTC instant as a business-timezone clock label, e.g. "8:00 AM".
 * Always renders in Eastern via Intl timeZone, never the viewer's zone.
 */
export function formatBusinessTime(instant: Date): string {
  return instant.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

/**
 * Resolve a business-day (YYYY-MM-DD) + arrival window into the concrete UTC
 * instants the window occupies, with the window hours read as BUSINESS-timezone
 * (Eastern) wall-clock — the inverse of how the calendar renders them.
 *
 * This is the reschedule counterpart to arrival-window.ts's arrivalWindowForDate:
 * that helper applies the window hours in UTC (so "morning" persists 8–12 UTC),
 * which is fine for the legacy UTC-rendered surfaces but would land a job on the
 * WRONG row of the Eastern calendar grid. Here we want a drag onto the morning
 * row to persist 8 AM–12 PM EASTERN, so we convert each wall-clock hour through
 * businessWallClockToUtc (DST-correct via the real-instant offset probe). The two
 * helpers share the same window-hour table (arrivalWindowHours) so the bounds can
 * never drift apart.
 */
export function arrivalWindowUtcForBusinessDate(
  isoDate: string,
  window: ArrivalWindow,
): { readonly start: Date; readonly end: Date } {
  const [startHour, endHour] = arrivalWindowHours(window);
  return {
    start: businessWallClockToUtc(isoDate, startHour, 0),
    end: businessWallClockToUtc(isoDate, endHour, 0),
  };
}

/**
 * The discrete window ROWS the reschedule grid offers as drop targets, in render
 * order. `anytime` (a full-day span) is deliberately excluded: it isn't a single
 * slot a job can be dropped INTO — only the three contiguous bands are. Each
 * entry carries its Eastern wall-clock [startHour, endHour) so the UI can size
 * the droppable band against the same grid placeJobInGrid uses.
 */
export const RESCHEDULE_WINDOW_ROWS = [
  "morning",
  "afternoon",
  "evening",
] as const satisfies readonly ArrivalWindow[];

export type RescheduleWindowRow = (typeof RESCHEDULE_WINDOW_ROWS)[number];

/**
 * The fractional [top, height] of a window band within the visible grid, so a
 * droppable zone can be laid out over the same hours the cards place into.
 * Returns null when the window lies fully outside the grid.
 */
export function windowBandPlacement(
  window: RescheduleWindowRow,
  gridStartHour: number = CALENDAR_START_HOUR,
  gridEndHour: number = CALENDAR_END_HOUR,
): SlotPlacement | null {
  const [startHour, endHour] = arrivalWindowHours(window);
  const span = (gridEndHour - gridStartHour) * MINUTES_PER_HOUR;
  if (span <= 0) return null;
  const startMin = startHour * MINUTES_PER_HOUR;
  const endMin = endHour * MINUTES_PER_HOUR;
  const gridStartMin = gridStartHour * MINUTES_PER_HOUR;
  const gridEndMin = gridEndHour * MINUTES_PER_HOUR;
  if (endMin <= gridStartMin || startMin >= gridEndMin) return null;
  const clampedStart = Math.max(startMin, gridStartMin);
  const clampedEnd = Math.min(endMin, gridEndMin);
  return {
    top: (clampedStart - gridStartMin) / span,
    height: (clampedEnd - clampedStart) / span,
  };
}

/**
 * Which window row an arrival-window START instant currently sits in, read in
 * the business timezone (Eastern). Used for OPTIMISTIC UI: when a card is dropped
 * we already know the target row, but to know whether a move is a no-op (same
 * day + window) we map the current instant back to a row. Returns null when the
 * instant doesn't fall in a discrete band (e.g. an `anytime` job spanning all
 * day, which has no single row). The boundary is half-open: 12:00 belongs to
 * afternoon, not morning.
 */
export function windowRowOfInstant(instant: Date): RescheduleWindowRow | null {
  const minutes = businessMinutesOfDay(instant);
  for (const row of RESCHEDULE_WINDOW_ROWS) {
    const [startHour, endHour] = arrivalWindowHours(row);
    if (minutes >= startHour * MINUTES_PER_HOUR && minutes < endHour * MINUTES_PER_HOUR) {
      return row;
    }
  }
  return null;
}

/**
 * The 7 business-day ISO dates of the week containing `isoDate`, Sunday-first.
 * The week is anchored in the business timezone: we resolve each day from the
 * business-tz midnight instant so week boundaries match the rendered grid.
 */
export function businessWeekDates(isoDate: string): readonly string[] {
  // Midday avoids any DST-midnight edge when deriving the weekday.
  const noonUtc = businessWallClockToUtc(isoDate, 12, 0);
  const wall = toBusinessWallClock(noonUtc);
  const refMs = Date.UTC(wall.year, wall.month - 1, wall.day);
  const weekday = new Date(refMs).getUTCDay(); // 0=Sun
  const dates: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const dayMs = refMs + (i - weekday) * 24 * MINUTES_PER_HOUR * MS_PER_MINUTE;
    dates.push(new Date(dayMs).toISOString().slice(0, 10));
  }
  return dates;
}
