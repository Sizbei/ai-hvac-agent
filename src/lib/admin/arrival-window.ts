/**
 * Arrival-window scheduling math + formatting.
 *
 * ServiceTitan books an arrival WINDOW (e.g. "Jun 10, 8am–12pm"), never an exact
 * minute. A dispatcher picks a date + one of these windows; we turn that into
 * concrete `arrival_window_start` / `arrival_window_end` timestamps stored on
 * the request. Pure (no I/O, no Date.now()) so it unit-tests deterministically.
 */

export const ARRIVAL_WINDOWS = [
  "morning",
  "afternoon",
  "evening",
  "anytime",
] as const;

export type ArrivalWindow = (typeof ARRIVAL_WINDOWS)[number];

// Window → [startHour, endHour) in local time, 24h.
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
 * Resolve a chosen date + window into concrete start/end timestamps on that
 * calendar day. The date's calendar day (local) is used; the time-of-day is
 * replaced by the window bounds.
 */
export function arrivalWindowForDate(
  date: Date,
  window: ArrivalWindow,
): { readonly start: Date; readonly end: Date } {
  const [startHour, endHour] = WINDOW_HOURS[window];
  const start = new Date(date);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(date);
  end.setHours(endHour, 0, 0, 0);
  return { start, end };
}

/** Human label for a persisted arrival window, e.g. "Jun 10, 8:00 AM – 12:00 PM". */
export function formatArrivalWindow(
  startIso: string | null,
  endIso: string | null,
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time(start)} – ${time(end)}`;
}
