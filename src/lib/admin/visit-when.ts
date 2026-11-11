/**
 * The day-and-time line for one visit in the request sheet's Visits list.
 * A visit booked on a standard band reads "Mon, Jul 13 Morning (8am–12pm)";
 * any other window (imported FieldPulse jobs keep their real 8–10 AM slot)
 * reads "Mon, Jul 13 · 8 AM–10 AM", so it never contradicts the arrival window
 * shown under Status & scheduling. Business time zone throughout. Pure.
 */
import { WINDOW_LABELS, formatIsoDayShort } from "@/lib/admin/create-request";
import { arrivalWindowHours } from "@/lib/admin/arrival-window";
import {
  BUSINESS_TIME_ZONE,
  RESCHEDULE_WINDOW_ROWS,
  businessIsoDate,
  businessMinutesOfDay,
  formatBusinessTime,
  formatBusinessTimeRange,
  type RescheduleWindowRow,
} from "@/lib/admin/calendar-time";

function validDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The band a window exactly fills (same business day, band start to end), else null. */
export function exactBand(start: Date, end: Date): RescheduleWindowRow | null {
  if (businessIsoDate(start) !== businessIsoDate(end)) return null;
  const s = businessMinutesOfDay(start);
  const e = businessMinutesOfDay(end);
  for (const row of RESCHEDULE_WINDOW_ROWS) {
    const [startHour, endHour] = arrivalWindowHours(row);
    if (s === startHour * 60 && e === endHour * 60) return row;
  }
  return null;
}

export function visitWhenLabel(
  arrivalWindowStart: string | null,
  arrivalWindowEnd: string | null,
  scheduledDate: string | null,
): string {
  const start = validDate(arrivalWindowStart);
  if (!start) {
    return scheduledDate ? formatIsoDayShort(scheduledDate.slice(0, 10)) : "Not scheduled";
  }
  const day = formatIsoDayShort(businessIsoDate(start));
  const end = validDate(arrivalWindowEnd);
  if (!end || end <= start) return `${day} · ${formatBusinessTime(start)}`;
  const band = exactBand(start, end);
  return band ? `${day} ${WINDOW_LABELS[band]}` : `${day} · ${formatBusinessTimeRange(start, end)}`;
}

/** "Jul 29, 2026" in business time; null for a missing or bad value. */
export function businessDateLabel(iso: string | null | undefined): string | null {
  const d = validDate(iso ?? null);
  if (!d) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: BUSINESS_TIME_ZONE,
  });
}
