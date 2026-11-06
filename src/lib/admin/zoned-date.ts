/**
 * Calendar dates in an arbitrary IANA time zone (the org's business zone),
 * for exports that must bucket by the day the business saw, not UTC. A
 * payment taken at 8 pm Eastern on Nov 5 is a Nov 5 payment. DST-correct:
 * offsets are probed from real instants through Intl, never hard-coded.
 * Pure: no I/O, no Date.now().
 */

const MS_PER_MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: Date, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/** The YYYY-MM-DD date an instant falls on in `timeZone`. */
export function dateInZone(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** UTC offset in minutes (e.g. -300 for EST) in effect in `timeZone` at `instant`. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const floored = Math.floor(instant.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return Math.round((asUtc - floored) / MS_PER_MINUTE);
}

/** The UTC instant of midnight starting `isoDate` (YYYY-MM-DD) in `timeZone`. */
export function zonedMidnight(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  const firstOffset = offsetMinutes(new Date(naive), timeZone);
  const guess = naive - firstOffset * MS_PER_MINUTE;
  const guessOffset = offsetMinutes(new Date(guess), timeZone);
  return new Date(naive - guessOffset * MS_PER_MINUTE);
}

/** The day after `isoDate`, as YYYY-MM-DD. */
function nextIsoDate(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Inclusive UTC bounds covering whole business days `fromDay`..`toDay` in
 * `timeZone`: from that zone's midnight on `fromDay` to the last millisecond
 * before midnight after `toDay`.
 */
export function zonedDayRange(
  fromDay: string,
  toDay: string,
  timeZone: string,
): { readonly fromDate: Date; readonly toDate: Date } {
  return {
    fromDate: zonedMidnight(fromDay, timeZone),
    toDate: new Date(zonedMidnight(nextIsoDate(toDay), timeZone).getTime() - 1),
  };
}
