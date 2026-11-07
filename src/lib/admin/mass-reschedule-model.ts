/**
 * Mass reschedule classification (M2 spec §5.6), pure: what happens to each
 * visit technician T is on that day when it moves to day D2 and/or lead T2.
 * Order: fieldpulse, helper, later_visit, ended, started, window_ended,
 * already_on_visit, time_off; else it moves, with a soft conflict flag.
 */
import { moveNeeds, type NeedsRow } from "./board-move";
import { keepWindowOn, timeOffHits, windowHasEndedAt, type TimeWindow } from "./move-window";
import type { BoardBlock, MassOutcome } from "./board-types";

export interface MassVisitFacts {
  readonly visitId: string;
  readonly requestId: string;
  readonly visitNumber: number;
  readonly window: TimeWindow;
  readonly fieldpulse: boolean;
  /** T is this visit's lead (else T is a helper on it). */
  readonly techIsLead: boolean;
  /** Visit cancelled, or a hold ended the request's visits. */
  readonly ended: boolean;
  /** Live rows on the visit. */
  readonly rows: readonly NeedsRow[];
  /** T2 has any row on the visit, cancelled included. */
  readonly toTechOnVisit: boolean;
}

export interface MassContext {
  readonly technicianId: string;
  readonly toTechnicianId: string | null;
  readonly fromDate: string;
  readonly toDate: string;
  readonly now: Date;
  readonly blocks: readonly BoardBlock[];
  /** Open rows of other requests' live visits, per technician. */
  readonly busy: readonly { readonly technicianId: string; readonly requestId: string; readonly start: Date; readonly end: Date }[];
  readonly outsideHours: (technicianId: string, window: TimeWindow) => boolean;
  /** Requests moving together in this run: they already sat together on D, so they never conflict with each other (plan v2, critic A MAJOR-1). */
  readonly batchRequestIds?: readonly string[];
}

export interface MassClassification {
  readonly outcome: MassOutcome;
  readonly conflict: boolean;
  readonly newWindow: TimeWindow;
}

export function classifyMassVisit(f: MassVisitFacts, ctx: MassContext): MassClassification {
  const dayChanges = ctx.toDate !== ctx.fromDate;
  const leadChanges = ctx.toTechnicianId !== null && ctx.toTechnicianId !== ctx.technicianId;
  const newWindow = dayChanges ? keepWindowOn(f.window, ctx.toDate) : f.window;
  const skip = (outcome: MassOutcome): MassClassification => ({ outcome, conflict: false, newWindow });
  if (f.fieldpulse) return skip("fieldpulse");
  if (!f.techIsLead) return skip("helper");
  if (f.visitNumber > 1) return skip("later_visit");
  if (f.ended) return skip("ended");
  const lead = leadChanges ? ctx.toTechnicianId! : ctx.technicianId;
  const needs = moveNeeds({ leadChanges, windowChanges: dayChanges, currentLeadId: ctx.technicianId, newLeadId: lead, rows: f.rows });
  if (needs.started) return skip("started");
  if (dayChanges && windowHasEndedAt(newWindow, ctx.now)) return skip("window_ended");
  if (leadChanges && f.toTechOnVisit) return skip("already_on_visit");
  if (timeOffHits(ctx.blocks, needs.checked, newWindow).length > 0) return skip("time_off");
  const checked = new Set(needs.checked);
  const batch = new Set(ctx.batchRequestIds ?? []);
  const overlap = ctx.busy.some(
    (b) => checked.has(b.technicianId) && b.requestId !== f.requestId && !batch.has(b.requestId) &&
      b.start.getTime() < newWindow.end.getTime() && b.end.getTime() > newWindow.start.getTime(),
  );
  const outside = checked.has(lead) && ctx.outsideHours(lead, newWindow);
  return { outcome: "moves", conflict: overlap || outside, newWindow };
}

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The next weekday (Mon–Fri) after `fromDate` (spec §7.6 default). */
export function massDefaultDay(fromDate: string): string {
  let day = addDays(fromDate, 1);
  while ([0, 6].includes(new Date(`${day}T12:00:00.000Z`).getUTCDay())) day = addDays(day, 1);
  return day;
}

export function massDayShift(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000);
}

/** Anything to move: another day, or another technician. */
export function massChanges(q: { readonly fromDate: string; readonly toDate: string; readonly technicianId: string; readonly toTechnicianId: string | null }): boolean {
  return q.toDate !== q.fromDate || (q.toTechnicianId !== null && q.toTechnicianId !== q.technicianId);
}
