/**
 * Splits the technician's Today tab. Open visits dated more than a week ago
 * (typically imported jobs nobody closed) would otherwise flood the list as
 * "Overdue", so they move to a collapsed "Older open jobs" group. That holds
 * for rows marked en route or in progress too: imported FieldPulse jobs carry
 * months-old "in progress" statuses, and real work started within the week
 * stays on top by date anyway.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

/** Overdue visits up to this many days old stay in the main Today list. */
export const RECENT_OVERDUE_DAYS = 7;

export interface TodayJobLike {
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
}

function businessDay(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(d);
}

function daysBefore(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function splitTodayJobs<T extends TodayJobLike>(
  jobs: readonly T[],
  now: Date,
  timeZone: string = BUSINESS_BASE_LOCATION.timezone,
): { current: T[]; older: T[] } {
  const today = businessDay(now.toISOString(), timeZone) ?? now.toISOString().slice(0, 10);
  const cutoff = daysBefore(today, RECENT_OVERDUE_DAYS);
  const current: T[] = [];
  const older: { job: T; at: number }[] = [];
  for (const job of jobs) {
    const iso = job.scheduledDate ?? job.arrivalWindowStart;
    const day = iso ? businessDay(iso, timeZone) : null;
    if (iso && day !== null && day < cutoff) older.push({ job, at: Date.parse(iso) });
    else current.push(job);
  }
  // Most recent first, by the same date the grouping uses: the server orders
  // by window start, which puts date-only visits (no window) last whatever
  // their date, so the input order can't be reversed into this one.
  older.sort((a, b) => b.at - a.at);
  return { current, older: older.map((o) => o.job) };
}
