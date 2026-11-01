import { businessWallClockToUtc, isRealIsoDate } from "./calendar-time";

export interface ShiftSpan {
  readonly startsAt: string;
  readonly endsAt: string;
}

const MAX_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseHm(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/**
 * One ISO span per calendar day (business timezone) from `startIso` to `endIso`
 * inclusive, each with the same wall-clock start/end times. Returns [] for any
 * invalid input: bad dates/times, end date before start, end time not after
 * start time, or a range over 31 days.
 */
export function expandDailyShifts(
  startIso: string,
  endIso: string,
  startHm: string,
  endHm: string,
): readonly ShiftSpan[] {
  if (!isRealIsoDate(startIso) || !isRealIsoDate(endIso)) return [];
  const start = parseHm(startHm);
  const end = parseHm(endHm);
  if (!start || !end) return [];
  if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) return [];
  const first = Date.parse(`${startIso}T00:00:00Z`);
  const last = Date.parse(`${endIso}T00:00:00Z`);
  if (last < first) return [];
  const days = Math.round((last - first) / DAY_MS) + 1;
  if (days > MAX_DAYS) return [];
  const spans: ShiftSpan[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
    spans.push({
      startsAt: businessWallClockToUtc(day, start.hour, start.minute).toISOString(),
      endsAt: businessWallClockToUtc(day, end.hour, end.minute).toISOString(),
    });
  }
  return spans;
}

/** The ISO day `savedCount` days after `startIso` (the first day not yet saved). */
export function firstUnsavedDay(startIso: string, savedCount: number): string {
  const ms = Date.parse(`${startIso}T00:00:00Z`) + savedCount * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}
