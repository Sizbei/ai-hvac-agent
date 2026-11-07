/**
 * Every M2 board and dispatch string (spec §8; lead ruling 10: U+2019
 * apostrophes). Pure and client-safe; components and routes import from here
 * so copy never forks.
 */
import { BUSINESS_TIME_ZONE, businessIsoDate, formatBusinessTimeRange } from "./calendar-time";
import { WINDOW_ENDED_MESSAGE } from "./window-ended";
import type { ConflictDetail, CrewMember, MassReason, MoveNeedsDetails } from "./board-types";

export const MOVE_GENERIC = "Couldn’t move the request. Please try again.";
export const STALE_LINE = "This request changed. The calendar has been refreshed.";
export const MOVED = "Moved.";
export const CALL_THEM = "Technicians aren’t told about this move. Call them.";
export const PROMPT_FOOTNOTE = "The customer isn’t told about this change.";
export const INTERACTIVE_NOTICE = "Dragging needs a computer. Use Move… on a request, or open it.";
export const SR_INSTRUCTIONS = "Use Move… to move a request with the keyboard.";
export const STARTED_CUE_TITLE = "Started. Moving it asks first.";
export const FIELDPULSE_BOARD = "Change this request in FieldPulse.";
export const FIELDPULSE_SHEET_TECH = "Change the technician for this request in FieldPulse.";
export const FIELDPULSE_SHEET_CREW = "Change the technicians for this request in FieldPulse.";
export const FIELDPULSE_SHEET_STARTED = "A technician has started this visit. Change it in FieldPulse.";
export const SHEET_STARTED_NATIVE = "A technician has started this visit. To move it anyway, use Move… on the calendar.";
export const TIME_OFF_TITLE = "Can’t move this request";
export const TIME_OFF_FOOTER = "Pick another time or technician.";
export const OUT_OF_HOURS_LINE = "This window falls outside the technician’s configured working hours.";

export const UNSCHEDULE_COPY = {
  HAS_PROGRESS: "A technician has started this visit, so it can’t go back to Unscheduled.",
  WORK_LOGGED: "Work was logged on this visit, so it can’t go back to Unscheduled.",
  STALE: STALE_LINE,
} as const;

export const MASS_COPY = {
  previewFailed: "Couldn’t load the preview. Please try again.",
  tryAgain: "Try again",
  empty: "No requests to move on this day.",
  overlap: "Move them even where they overlap",
  commitFailed: "Couldn’t move the requests. Please try again.",
  keyReused: "This move was already sent with different choices. Open the preview again.",
  pushesNotSent: "Not sent to Housecall Pro. Open it to retry.",
  sameTechnician: "Same technician",
  moves: "Moves",
  menuItem: "Move this day…",
} as const;

export function firstName(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0]! : "A technician";
}

/** "Tue, Nov 10" for a business-tz ISO day. */
export function dayLabel(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Tue, Nov 10" for the business day an instant falls on. */
export function instantDayLabel(instant: Date): string {
  return instant.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: BUSINESS_TIME_ZONE });
}

export function rangeLabel(start: string | Date, end: string | Date): string {
  return formatBusinessTimeRange(new Date(start), new Date(end));
}

export function coveredLine(range: string): string {
  return `Still ${range}. Use Move… to change the window.`;
}

const STARTED_VERB: Record<string, string> = {
  en_route: "is en route to this visit.",
  arrived: "has arrived.",
  in_progress: "is in progress on this visit.",
  on_hold: "is paused on this visit.",
  completed: "is done with this visit.",
};
const MARKED: Record<string, string> = { en_route: "en route", arrived: "arrived", in_progress: "in progress", completed: "done" };

/** Line 1 of the started confirm. A status with no timestamp is the office's mirror: "This visit is marked in progress." */
export function startedLine(fullName: string | null, status: string, hasTimestamp: boolean): string {
  if (!hasTimestamp && MARKED[status]) return `This visit is marked ${MARKED[status]}.`;
  return `${fullName ?? "A technician"} ${STARTED_VERB[status] ?? "has started this visit."}`;
}

export interface ConfirmContext {
  readonly names: ReadonlyMap<string, string>;
  readonly oldLeadId: string | null;
  readonly newLeadId: string | null;
  readonly leadChanges: boolean;
  readonly windowChanges: boolean;
  /** The new window, "12 PM–4 PM". */
  readonly range: string;
  /** "Wed, Nov 11" when the day changes, else null. */
  readonly dayLabel: string | null;
  readonly resetsToScheduled: boolean;
}

/** The "Move anyway?" body for a 409 HAS_PROGRESS (spec §8; lead ruling 10). */
export function confirmLines(details: MoveNeedsDetails, ctx: ConfirmContext): string[] {
  if (!details.needs.includes("started")) return [];
  const name = (id: string | null) => (id ? (ctx.names.get(id) ?? null) : null);
  const started = details.started ?? [];
  const moveLine = `It moves to ${ctx.range}${ctx.dayLabel ? ` on ${ctx.dayLabel}` : ""}.`;
  const lines: string[] = [];
  const oldStarted = ctx.leadChanges ? started.find((s) => s.technicianId === ctx.oldLeadId) : undefined;
  if (oldStarted) {
    const oldFirst = firstName(name(ctx.oldLeadId));
    lines.push(startedLine(name(oldStarted.technicianId), oldStarted.status, oldStarted.hasTimestamp));
    let handover = `${oldFirst} comes off the visit. ${firstName(name(ctx.newLeadId))} becomes the lead and takes over close-out, the invoice and estimates.`;
    if (ctx.resetsToScheduled) handover += " The request goes back to scheduled.";
    if (oldStarted.openTimeEntry) handover += ` ${oldFirst}’s time on it stops.`;
    lines.push(handover);
    for (const s of started) if (s !== oldStarted) lines.push(startedLine(name(s.technicianId), s.status, s.hasTimestamp));
    if (ctx.windowChanges) lines.push(moveLine);
  } else {
    for (const s of started) lines.push(startedLine(name(s.technicianId), s.status, s.hasTimestamp));
    lines.push(moveLine);
  }
  lines.push(CALL_THEM);
  return lines;
}

/** "Overlapping requests:" rows; first names only when more than one technician is involved. */
export function conflictRows(conflicts: readonly ConflictDetail[], names: ReadonlyMap<string, string>): string[] {
  const many = new Set(conflicts.map((c) => c.technicianId)).size > 1;
  return conflicts.map((c) => {
    const base = `${c.referenceNumber} · ${rangeLabel(c.arrivalWindowStart, c.arrivalWindowEnd)}`;
    return many ? `${base} · ${firstName(names.get(c.technicianId) ?? null)}` : base;
  });
}

/** One time-off dialog line (spec §8). `helper`: the technician is a helper the dispatcher could remove instead. */
export function timeOffLine(
  fullName: string | null,
  block: { readonly startsAt: string; readonly endsAt: string; readonly kind: "on_call" | "time_off" | "non_job" },
  helper: boolean,
): string {
  const who = firstName(fullName);
  const start = new Date(block.startsAt);
  const end = new Date(block.endsAt);
  const firstDay = businessIsoDate(start);
  const lastDay = businessIsoDate(new Date(end.getTime() - 1));
  const what = block.kind === "time_off" ? "is off" : "has a non-job event";
  const when = firstDay === lastDay ? `${rangeLabel(start, end)} on ${dayLabel(firstDay)}` : `${dayLabel(firstDay)} – ${dayLabel(lastDay)}`;
  return `${who} ${what} ${when}.${helper ? ` Or remove ${who} in the request.` : ""}`;
}

/** The banner for a refused move (spec §8 "Banners"). */
export function moveErrorBanner(code: string, details?: unknown, names?: ReadonlyMap<string, string>): string {
  const d = (details ?? {}) as { visitNumber?: number; status?: string; technicianId?: string };
  switch (code) {
    case "STALE":
      return STALE_LINE;
    case "VISIT_ENDED":
      return "This visit has ended. Add a new visit instead.";
    case "VISIT_PINNED":
      return `Visit #${d.visitNumber ?? 2}. Change its time in the request.`;
    case "REQUEST_TERMINAL":
      return d.status === "cancelled" ? "This request is cancelled, so it can’t be moved." : "This request is completed, so it can’t be moved.";
    case "TECHNICIAN_NOT_FOUND":
      return "That technician isn’t active any more.";
    case "TECHNICIAN_DONE":
      return `${firstName(d.technicianId ? (names?.get(d.technicianId) ?? null) : null)} has finished on this visit.`;
    case "WINDOW_ENDED":
      return WINDOW_ENDED_MESSAGE;
    case "MANAGED_EXTERNALLY":
      return FIELDPULSE_BOARD;
    default:
      return MOVE_GENERIC;
  }
}

/** The success banner: a lead change that takes the old lead off names both (spec §7.5). */
export function moveBanner(before: readonly CrewMember[], after: readonly CrewMember[]): string {
  const oldLead = before.find((c) => c.isLead);
  const newLead = after.find((c) => c.isLead);
  if (oldLead && newLead && oldLead.technicianId !== newLead.technicianId && !after.some((c) => c.technicianId === oldLead.technicianId)) {
    return `${firstName(newLead.name)} is now the lead. ${firstName(oldLead.name)} is off this visit.`;
  }
  return MOVED;
}

export function massReasonLabel(
  reason: MassReason | "conflict",
  ctx: { readonly visitNumber?: number; readonly toFirstName?: string; readonly leadFirstName?: string },
): string {
  switch (reason) {
    case "started": return "Started";
    case "ended": return "Visit ended";
    case "later_visit": return `Visit #${ctx.visitNumber ?? 2}. Change it in the request.`;
    case "time_off": return "Time off then";
    case "window_ended": return "That time has passed";
    case "already_on_visit": return `${ctx.toFirstName ?? "That technician"} is already on it`;
    case "fieldpulse": return "Change it in FieldPulse";
    case "helper": return `Helping ${ctx.leadFirstName ?? "another technician"}. Change it in the request.`;
    case "stale": return "Changed since you opened this";
    case "conflict": return "Overlaps another request";
  }
}

export function massResultHeadline(moved: number, fromFirst: string, toFirst: string | null, toDayLabel: string | null): string {
  if (moved === 0) return `None of ${fromFirst}’s requests moved.`;
  const to = [toFirst ? ` to ${toFirst}` : "", toDayLabel ? `${toFirst ? " on" : " to"} ${toDayLabel}` : ""].join("");
  return `Moved ${moved} of ${fromFirst}’s requests${to}.`;
}

export function massMoveButton(n: number): string {
  return n === 1 ? "Move 1 request" : `Move ${n} requests`;
}

export function massDialogTitle(technicianName: string, fromDayLabel: string): string {
  return `Move ${firstName(technicianName)}’s requests on ${fromDayLabel}`;
}
