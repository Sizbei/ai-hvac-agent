/**
 * The calendar's move model (M2 spec §5.3, §7): which technicians a move
 * checks, the optimistic crew, helper copies, the post-move board, "did my
 * move land" after a STALE refetch, layout rules and the Move… dialog. Pure
 * and client-safe.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import { arrivalWindowUtcForBusinessDate, businessIsoDate, toBusinessWallClock, windowRowOfInstant } from "./calendar-time";
import { UNASSIGNED_SCOPE } from "./calendar-optimistic";
import { keepWindowOn, windowEqual, windowHasEndedAt } from "./move-window";
import { rowStarted } from "./visit-started";
import type { CrewMember, CrewState, MoveBand, MoveBody, MoveSuccessData, StartedDetail } from "./board-types";
import type { DashboardRequest, SchedulingCalendar } from "./types";

// ── needs ────────────────────────────────────────────────────────────────────

export interface NeedsRow {
  readonly technicianId: string;
  readonly isLead: boolean;
  readonly status: string;
  readonly hasTimestamp: boolean;
}

export interface MoveNeedsInput {
  readonly leadChanges: boolean;
  readonly windowChanges: boolean;
  readonly currentLeadId: string | null;
  readonly newLeadId: string | null;
  readonly rows: readonly NeedsRow[];
}

export interface MoveNeeds {
  /** Technicians the move assigns: checked for time off and overlaps. */
  readonly checked: readonly string[];
  readonly started: boolean;
  readonly startedRows: readonly NeedsRow[];
}

/**
 * The new lead when the lead changes; when the window changes, every live crew
 * member who stays (the old lead leaves on a lead change). `started`: the lead
 * changes and the current lead's row is started, or the window changes and any
 * live row is started.
 */
export function moveNeeds(i: MoveNeedsInput): MoveNeeds {
  const live = i.rows.filter((r) => r.status !== "cancelled");
  const checked = new Set<string>();
  if (i.leadChanges && i.newLeadId) checked.add(i.newLeadId);
  if (i.windowChanges) {
    for (const r of live) {
      if (i.leadChanges && r.technicianId === i.currentLeadId) continue;
      checked.add(r.technicianId);
    }
    if (i.newLeadId) checked.add(i.newLeadId);
  }
  const startedRows = live.filter(
    (r) => rowStarted(r) && (i.windowChanges || (i.leadChanges && r.isLead && r.technicianId === i.currentLeadId)),
  );
  return { checked: [...checked], started: startedRows.length > 0, startedRows };
}

const RESET_FROM: readonly string[] = ["en_route", "arrived", "in_progress", "on_hold"];

/** A lead change past a started lead resets a native request to scheduled when nobody else is started (spec §5.3 step 1). */
export function resetsToScheduled(p: {
  readonly status: string;
  readonly native: boolean;
  readonly oldLeadId: string | null;
  readonly started: readonly StartedDetail[];
  /** From the 409's details: a row other than the old lead's is started (a lead-only 409 lists only the lead in `started`). */
  readonly othersStarted?: boolean;
}): boolean {
  if (!p.native || !RESET_FROM.includes(p.status) || !p.oldLeadId || p.othersStarted) return false;
  return p.started.some((s) => s.technicianId === p.oldLeadId) && p.started.every((s) => s.technicianId === p.oldLeadId);
}

// ── crew and lanes ─────────────────────────────────────────────────────────────

/** The crew after a lead change: the new lead out of the helpers, the old lead off. */
export function optimisticCrew(crew: readonly CrewMember[], newLeadId: string, newLeadName: string | null): CrewMember[] {
  if (crew.find((c) => c.isLead)?.technicianId === newLeadId) return [...crew];
  const promoted = crew.find((c) => c.technicianId === newLeadId);
  const lead: CrewMember = { technicianId: newLeadId, name: promoted?.name ?? newLeadName, isLead: true, state: promoted?.state ?? "open" };
  return [lead, ...crew.filter((c) => !c.isLead && c.technicianId !== newLeadId)];
}

const byStart = (a: DashboardRequest, b: DashboardRequest) =>
  (a.arrivalWindowStart ?? "").localeCompare(b.arrivalWindowStart ?? "");
const isCopy = (j: DashboardRequest) => j.laneRole === "helper";

/** Day view: a non-draggable copy of each card in every helper's lane (spec §7.2). Idempotent. */
export function laneCards(board: SchedulingCalendar): SchedulingCalendar {
  const lanes0 = board.lanes.map((l) => ({ ...l, jobs: l.jobs.filter((j) => !isCopy(j)) }));
  const unassigned = board.unassigned.filter((j) => !isCopy(j));
  const laneIds = new Set(lanes0.map((l) => l.technicianId));
  const copies = new Map<string, DashboardRequest[]>();
  for (const job of [...lanes0.flatMap((l) => l.jobs), ...unassigned]) {
    if (job.visitEnded) continue;
    for (const m of job.crew ?? []) {
      if (m.isLead || !laneIds.has(m.technicianId)) continue;
      const list = copies.get(m.technicianId) ?? [];
      list.push({ ...job, laneRole: "helper", laneTechnicianId: m.technicianId });
      copies.set(m.technicianId, list);
    }
  }
  const lanes = lanes0.map((l) => {
    const extra = copies.get(l.technicianId);
    return extra ? { ...l, jobs: [...l.jobs, ...extra].sort(byStart) } : l;
  });
  return { ...board, lanes, unassigned };
}

/** React key for a card: a helper copy is `${requestId}:${technicianId}`. */
export function laneKey(job: DashboardRequest): string {
  return isCopy(job) && job.laneTechnicianId ? `${job.id}:${job.laneTechnicianId}` : job.id;
}

/** The request's lead card and where it sits: a technician id, "unassigned" or "unscheduled". */
export function findLeadCard(board: SchedulingCalendar, requestId: string): { readonly card: DashboardRequest; readonly scope: string } | null {
  for (const lane of board.lanes) {
    const hit = lane.jobs.find((j) => j.id === requestId && !isCopy(j));
    if (hit) return { card: hit, scope: lane.technicianId };
  }
  const placed = board.unassigned.find((j) => j.id === requestId && !isCopy(j));
  if (placed) return { card: placed, scope: UNASSIGNED_SCOPE };
  const queued = board.unscheduled.find((j) => j.id === requestId);
  return queued ? { card: queued, scope: "unscheduled" } : null;
}

/** Write the 200's version, window, status and lead into the board before the refetch (spec §7.4 step 7). */
export function applyMoveResult(
  board: SchedulingCalendar,
  requestId: string,
  data: MoveSuccessData,
  names: ReadonlyMap<string, string>,
): SchedulingCalendar {
  const found = findLeadCard(board, requestId);
  if (!found) return board;
  const prev = found.card;
  const prevLead = prev.crew?.find((c) => c.isLead)?.technicianId ?? null;
  const leadChanged = data.leadId !== null && data.leadId !== prevLead;
  const next: DashboardRequest = {
    ...prev,
    visitId: data.visitId,
    visitVersion: data.visitVersion,
    status: data.requestStatus,
    arrivalWindowStart: data.arrivalWindowStart,
    arrivalWindowEnd: data.arrivalWindowEnd,
    assignedToName: data.leadId ? (names.get(data.leadId) ?? prev.assignedToName) : prev.assignedToName,
    crew: leadChanged ? optimisticCrew(prev.crew ?? [], data.leadId!, names.get(data.leadId!) ?? null) : prev.crew,
    laneRole: "lead",
  };
  const target = data.leadId && board.lanes.some((l) => l.technicianId === data.leadId) ? data.leadId : null;
  const without = (jobs: readonly DashboardRequest[]) => jobs.filter((j) => j.id !== requestId);
  return {
    ...board,
    lanes: board.lanes.map((l) => ({ ...l, jobs: l.technicianId === target ? [...without(l.jobs), next].sort(byStart) : without(l.jobs) })),
    unassigned: target ? without(board.unassigned) : [...without(board.unassigned), next].sort(byStart),
    unscheduled: without(board.unscheduled),
  };
}

export type IntendedMove =
  | { readonly requestId: string; readonly leadId: string | null; readonly start: string; readonly end: string }
  | { readonly requestId: string; readonly unscheduled: true };

const sameInstant = (a: string | null | undefined, b: string) => a !== null && a !== undefined && Date.parse(a) === Date.parse(b);

/** After a STALE or a lost response: does the refetched board show the move as made? (spec §4.2) */
export function moveLanded(board: SchedulingCalendar, intended: IntendedMove): boolean {
  const found = findLeadCard(board, intended.requestId);
  if (!found) return false;
  if ("unscheduled" in intended) return found.scope === "unscheduled";
  if (found.scope === "unscheduled") return false;
  const lane = found.scope === UNASSIGNED_SCOPE ? null : found.scope;
  return lane === intended.leadId && sameInstant(found.card.arrivalWindowStart, intended.start) && sameInstant(found.card.arrivalWindowEnd, intended.end);
}

// ── layout ─────────────────────────────────────────────────────────────────────

/** Drag only at ≥ 1024 px with a fine pointer (spec §7.8). */
export function boardInteractive(width: number, finePointer: boolean): boolean {
  return width >= 1024 && finePointer;
}

export function showCrewChips(crew: readonly CrewMember[] | undefined): boolean {
  return (crew?.length ?? 0) >= 2;
}

/** Chips, or a people icon with the count: below 120 px wide, below 72 px high, or in Week view (spec §7.2). */
export function chipLayout(width: number, height: number, view: "day" | "week"): "chips" | "count" {
  return view === "week" || width < 120 || height < 72 ? "count" : "chips";
}

/** Lead first, then helpers; three chips and "+N" past three. */
export function crewChipModel(crew: readonly CrewMember[]): { readonly chips: readonly CrewMember[]; readonly more: number } {
  const ordered = [...crew.filter((c) => c.isLead), ...crew.filter((c) => !c.isLead)];
  return { chips: ordered.slice(0, 3), more: Math.max(0, ordered.length - 3) };
}

export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

const STATE_WORD: Record<CrewState, string> = { open: "not started", working: "working", done: "done" };
export function crewStateWord(state: CrewState): string {
  return STATE_WORD[state];
}

/** A card's width in a 224 px lane split into `columns` side-by-side slots (2 px gutters). */
export function cardWidthPx(columns: number): number {
  return 224 / Math.max(1, columns) - 4;
}

/** The FieldPulse pill: "FieldPulse" (md) on a Day card ≥ 160 px wide, else "FP" (sm). */
export function pillSize(view: "day" | "week", widthPx: number): "sm" | "md" {
  return view === "day" && widthPx >= 160 ? "md" : "sm";
}

// ── Move… dialog ───────────────────────────────────────────────────────────────

export interface MoveDialogForm {
  /** "" = Unassigned: keeps the card's current lead (a move never unassigns). */
  readonly technicianId: string;
  readonly day: string;
  readonly window: "keep" | ArrivalWindow;
}

export function bandEnded(day: string, window: ArrivalWindow, now: Date): boolean {
  return windowHasEndedAt(arrivalWindowUtcForBusinessDate(day, window), now);
}

function cardWindow(card: DashboardRequest): { start: Date; end: Date } | null {
  if (!card.arrivalWindowStart || !card.arrivalWindowEnd) return null;
  return { start: new Date(card.arrivalWindowStart), end: new Date(card.arrivalWindowEnd) };
}

function leadOf(card: DashboardRequest, fromUnscheduled: boolean): string {
  return fromUnscheduled ? "" : (card.crew?.find((c) => c.isLead)?.technicianId ?? "");
}

/** Defaults (spec §7.5): the lead (Unassigned for an unassigned or Unscheduled card), the card's day (else today), Keep (else the first band that hasn't ended). */
export function moveDialogDefaults(card: DashboardRequest, today: string, now: Date, fromUnscheduled = false): MoveDialogForm {
  const win = cardWindow(card);
  const day = win ? businessIsoDate(win.start) : today;
  if (win) return { technicianId: leadOf(card, fromUnscheduled), day, window: "keep" };
  const open = ARRIVAL_WINDOWS.find((w) => !bandEnded(day, w, now)) ?? "evening";
  return { technicianId: leadOf(card, fromUnscheduled), day, window: open };
}

/** The move body for the dialog's choices, or null while nothing changes (Move disabled). */
export function moveDialogBody(card: DashboardRequest, form: MoveDialogForm, fromUnscheduled = false): MoveBody | null {
  const win = cardWindow(card);
  const lead = leadOf(card, fromUnscheduled);
  const sameTech = form.technicianId === "" || form.technicianId === lead;
  const tech = sameTech ? {} : { technicianId: form.technicianId };
  const base = { visitId: card.visitId ?? null, expectedVersion: card.visitVersion ?? null, day: form.day, confirm: [] as const };
  if (form.window === "keep") {
    if (!win) return null;
    if (sameTech && form.day === businessIsoDate(win.start)) return null;
    const kept = keepWindowOn(win, form.day);
    const band: MoveBand = windowRowOfInstant(kept.start) ?? (toBusinessWallClock(kept.start).hour < 8 ? "morning" : "evening");
    return { ...base, band, windowRule: "keep", ...tech };
  }
  const picked = arrivalWindowUtcForBusinessDate(form.day, form.window);
  if (sameTech && win && windowEqual(win, picked)) return null;
  const band: MoveBand = form.window === "anytime" ? "morning" : form.window;
  return { ...base, band, windowRule: "pick", pick: form.window, ...tech };
}
