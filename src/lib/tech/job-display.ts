/**
 * Pure display formatters for the technician job list, job page and status
 * history. Dates render in the business timezone, like the list's tabs.
 * No React, no fetch — safe for client code and plain vitest.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { codeOrTextLabel } from "@/lib/admin/request-labels";

const BUSINESS_TZ = BUSINESS_BASE_LOCATION.timezone;

/** Codes whose plain humanized form reads poorly. */
const ISSUE_WORDS: Record<string, string> = {
  air_quality: "Indoor air quality",
  strange_noises: "Strange noises",
  ice_machine: "Ice machine",
  commercial_appliance: "Commercial appliance",
  other: "Other issue",
};

/** "cooling_not_working" -> "Cooling not working"; known codes map to nicer words.
 * An imported free-text title (a FieldPulse job name) is shown as typed. */
export function issueLabel(code: string | null | undefined): string {
  if (!code) return "Service request";
  const known = Object.hasOwn(ISSUE_WORDS, code) ? ISSUE_WORDS[code] : undefined;
  if (known) return known;
  return codeOrTextLabel(code) || "Service request";
}

/** Snake-case status -> sentence case: "in_progress" -> "In progress". */
export function statusLabel(status: string): string {
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function parts(d: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

function businessDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(d);
}

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayLabel(p: Record<string, string>, sameYear: boolean): string {
  return `${p.weekday}, ${p.month} ${p.day}${sameYear ? "" : `, ${p.year}`}`;
}

function timeLabel(p: Record<string, string>): string {
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** "Thu, Aug 13 · 10:41 PM"; the year shows only when it isn't this year. */
export function visitWhen(iso: string | null | undefined, now: Date, timeZone: string = BUSINESS_TZ): string | null {
  const d = validDate(iso);
  if (!d) return null;
  const p = parts(d, timeZone);
  const sameYear = p.year === parts(now, timeZone).year;
  return `${dayLabel(p, sameYear)} · ${timeLabel(p)}`;
}

/**
 * Arrival window for the job page: "Thu, Aug 13 · 8:00 AM – 12:00 PM". A
 * window that ends on another day names that day: "… 10:41 PM – Fri 12:41 AM".
 */
export function visitWindow(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: Date,
  timeZone: string = BUSINESS_TZ,
): string | null {
  const start = validDate(startIso);
  if (!start) return null;
  const head = visitWhen(startIso, now, timeZone);
  const end = validDate(endIso);
  if (!end || !head) return head;
  const pe = parts(end, timeZone);
  const sameDay = businessDay(start, timeZone) === businessDay(end, timeZone);
  return `${head} – ${sameDay ? "" : `${pe.weekday} `}${timeLabel(pe)}`;
}

const OPEN_DONE = new Set(["completed", "cancelled"]);

/** "Overdue · Aug 13" when the visit day is before today and the row is still open; else null. */
export function overdueLabel(
  visitIso: string | null | undefined,
  assignmentStatus: string,
  requestStatus: string,
  now: Date,
  timeZone: string = BUSINESS_TZ,
): string | null {
  const d = validDate(visitIso);
  if (!d) return null;
  if (OPEN_DONE.has(assignmentStatus) || OPEN_DONE.has(requestStatus) || requestStatus === "on_hold") return null;
  if (businessDay(d, timeZone) >= businessDay(now, timeZone)) return null;
  const p = parts(d, timeZone);
  const sameYear = p.year === parts(now, timeZone).year;
  return `Overdue · ${p.month} ${p.day}${sameYear ? "" : `, ${p.year}`}`;
}

/** The list badge: a held request reads "On hold", never the visit's "Completed". */
export function visitBadge(assignmentStatus: string, requestStatus: string): string {
  if (requestStatus === "on_hold" && assignmentStatus !== "cancelled") return "On hold";
  return statusLabel(assignmentStatus);
}
