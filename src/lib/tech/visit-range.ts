/**
 * Pure classification of a technician's assignment row into the tech list's
 * tabs. Days are business-timezone ISO dates (YYYY-MM-DD), so plain string
 * comparison is date comparison.
 */
export type VisitRange = "today" | "upcoming" | "past";
export type VisitBucket = VisitRange | "hidden";

export const VISIT_RANGES: readonly VisitRange[] = ["today", "upcoming", "past"];
export const PAST_WINDOW_DAYS = 30;

export interface VisitRow {
  readonly assignmentStatus: string;
  readonly requestStatus: string;
  /** Business day of the visit (appointment date, else the request's); null when undated. */
  readonly scheduledDay: string | null;
  /** Business day the row was completed; null when it has no completed_at. */
  readonly completedDay: string | null;
}

function isoDaysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function classifyVisit(row: VisitRow, businessTodayIso: string): VisitBucket {
  if (row.assignmentStatus === "completed" || row.assignmentStatus === "cancelled") {
    const day = row.completedDay ?? row.scheduledDay;
    if (day === null) return "past";
    return day >= isoDaysBefore(businessTodayIso, PAST_WINDOW_DAYS) ? "past" : "hidden";
  }
  if (row.requestStatus === "completed" || row.requestStatus === "cancelled") return "hidden";
  if (row.scheduledDay !== null && row.scheduledDay > businessTodayIso) return "upcoming";
  return "today";
}
