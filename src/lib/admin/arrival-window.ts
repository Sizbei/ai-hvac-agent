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

/** Human label for a persisted arrival window, e.g. "Jun 10, 8:00 AM – 12:00 PM". */
export function formatArrivalWindow(
  startIso: string | null,
  endIso: string | null,
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  // The window is stored UTC-anchored (see arrivalWindowForDate), so render it
  // in UTC for a stable label independent of the viewer's timezone.
  const day = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
  return `${day}, ${time(start)} – ${time(end)}`;
}
