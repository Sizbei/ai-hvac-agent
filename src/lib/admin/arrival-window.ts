/**
 * Arrival-window scheduling math + formatting.
 *
 * ServiceTitan books an arrival WINDOW (e.g. "Jun 10, 8am–12pm"), never an exact
 * minute. A dispatcher picks a date + one of these windows; we turn that into
 * concrete `arrival_window_start` / `arrival_window_end` timestamps stored on
 * the request. Pure (no I/O, no Date.now()) so it unit-tests deterministically.
 */

import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

export const ARRIVAL_WINDOWS = [
  "morning",
  "afternoon",
  "evening",
  "anytime",
] as const;

export type ArrivalWindow = (typeof ARRIVAL_WINDOWS)[number];

// Window → [startHour, endHour) applied in UTC (see arrivalWindowForDate), 24h.
const WINDOW_HOURS: Record<ArrivalWindow, readonly [number, number]> = {
  morning: [8, 12],
  afternoon: [12, 16],
  evening: [16, 20],
  anytime: [8, 20],
};

export function isArrivalWindow(value: string): value is ArrivalWindow {
  return (ARRIVAL_WINDOWS as readonly string[]).includes(value);
}

/**
 * The [startHour, endHour) bounds of a window, as plain wall-clock hours (24h).
 * Exposed so the calendar layer can apply them in the BUSINESS timezone (Eastern)
 * rather than the UTC interpretation arrivalWindowForDate uses — see
 * calendar-time.ts arrivalWindowUtcForBusinessDate. Single source of truth for
 * the window hours so the two interpretations never drift.
 */
export function arrivalWindowHours(
  window: ArrivalWindow,
): readonly [number, number] {
  return WINDOW_HOURS[window];
}

/**
 * Resolve a chosen date + window into concrete start/end timestamps on that
 * calendar day. The window bounds are applied in UTC so the result is
 * deployment-timezone-independent: the UI sends the chosen day as UTC midnight
 * (`<day>T00:00:00.000Z`), and we set the window hours with setUTCHours, so the
 * window always lands on the day the dispatcher picked regardless of the
 * server's TZ. (Using local setHours here would shift the window to the wrong
 * calendar day on any server west of UTC.)
 */
export function arrivalWindowForDate(
  date: Date,
  window: ArrivalWindow,
): { readonly start: Date; readonly end: Date } {
  const [startHour, endHour] = WINDOW_HOURS[window];
  const start = new Date(date);
  start.setUTCHours(startHour, 0, 0, 0);
  const end = new Date(date);
  end.setUTCHours(endHour, 0, 0, 0);
  return { start, end };
}

/** Human label for a persisted arrival window, e.g. "Jun 10, 8:00 AM – 12:00 PM".
 *
 * `timeZone` selects the wall clock to render in. Defaults to the BUSINESS
 * timezone because every live write path now anchors band hours there (via
 * arrivalWindowUtcForBusinessDate) — so an 8 AM ET window stored as 12:00Z reads
 * back as "8:00 AM", not "12:00 PM". (The legacy UTC-anchored arrivalWindowForDate
 * survives only in demo seed data.) Pass an explicit tz for a non-default org. */
export function formatArrivalWindow(
  startIso: string | null,
  endIso: string | null,
  timeZone: string = BUSINESS_BASE_LOCATION.timezone,
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone,
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    });
  return `${day}, ${time(start)} – ${time(end)}`;
}

/**
 * Spoken-friendly variant of the same window, for the voice channel's TTS —
 * e.g. "Wednesday, July 10 between 8 AM and 12 PM". No en-dash or 2-digit
 * minutes (they read awkwardly aloud); weekday + long month make the date
 * unambiguous by ear. Same `timeZone` semantics + degrade-safe null contract as
 * formatArrivalWindow (pass the business timezone for a slot-anchored window).
 */
export function formatArrivalWindowSpoken(
  startIso: string | null,
  endIso: string | null,
  timeZone: string = BUSINESS_BASE_LOCATION.timezone,
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = start.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      timeZone,
    });
  return `${day} between ${time(start)} and ${time(end)}`;
}
