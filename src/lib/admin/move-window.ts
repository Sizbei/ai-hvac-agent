/**
 * Window resolution for a board move (M2 spec §5.2). Pure; used by the client
 * (the prompt) and the server (the move recomputes from the window it read).
 * All wall-clock math is in the business timezone through calendar-time.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import {
  arrivalWindowUtcForBusinessDate,
  businessIsoDate,
  businessWallClockToUtc,
  toBusinessWallClock,
  type RescheduleWindowRow,
} from "./calendar-time";
import type { BoardBlock, WindowRule } from "./board-types";

export interface TimeWindow {
  readonly start: Date;
  readonly end: Date;
}

export type WindowKind = "band" | "anytime" | "custom" | "none";

export type PromptPlan =
  | { readonly kind: "use_band" }
  | { readonly kind: "keep" }
  /** Nothing is sent. `coveredLine`: show "Still <range>. Use Move… to change the window." */
  | { readonly kind: "noop"; readonly coveredLine: boolean }
  | { readonly kind: "prompt"; readonly defaultChoice: "match" | "keep"; readonly offerKeep: boolean };

export type ResolvedWindow = { readonly ok: true; readonly start: Date; readonly end: Date } | { readonly ok: false };

export function windowEqual(a: TimeWindow, b: TimeWindow): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

/** The named arrival window a span is exactly, on its start's business day, else null. */
export function namedWindowOf(start: Date | null, end: Date | null): ArrivalWindow | null {
  if (!start || !end) return null;
  const day = businessIsoDate(start);
  for (const name of ARRIVAL_WINDOWS) {
    if (windowEqual({ start, end }, arrivalWindowUtcForBusinessDate(day, name))) return name;
  }
  return null;
}

export function currentWindowKind(start: Date | null, end: Date | null): WindowKind {
  if (!start || !end) return "none";
  const named = namedWindowOf(start, end);
  if (named === "anytime") return "anytime";
  return named ? "band" : "custom";
}

const DAY_MS = 86_400_000;

/** Whole calendar days from `a` to `b` (YYYY-MM-DD; UTC date math is safe for whole days). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);
}

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The same wall-clock start and end on `day`; an end past midnight stays on the following day. DST-correct. */
export function keepWindowOn(current: TimeWindow, day: string): TimeWindow {
  const s = toBusinessWallClock(current.start);
  const e = toBusinessWallClock(current.end);
  const spanDays = dayDiff(businessIsoDate(current.start), businessIsoDate(current.end));
  return {
    start: businessWallClockToUtc(day, s.hour, s.minute),
    end: businessWallClockToUtc(addDays(day, spanDays), e.hour, e.minute),
  };
}

/** The current window, moved onto `day` with the same wall-clock times, overlaps band `band` (half-open). */
export function covers(current: TimeWindow | null, day: string, band: RescheduleWindowRow): boolean {
  if (!current) return false;
  const kept = keepWindowOn(current, day);
  const b = arrivalWindowUtcForBusinessDate(day, band);
  return kept.start.getTime() < b.end.getTime() && kept.end.getTime() > b.start.getTime();
}

/**
 * What a drop on band `band` of `day` does (spec §5.2): no window → use the
 * band; covered → keep (same lane and day → nothing is sent); otherwise ask.
 * Default "Use the new window" for a band window, "Keep" for anytime and custom
 * when the day or lead changes; with the same day and lead Keep would change
 * nothing, so it isn't offered.
 */
export function promptPlan(
  current: TimeWindow | null,
  day: string,
  band: RescheduleWindowRow,
  leadChanges: boolean,
): PromptPlan {
  if (!current) return { kind: "use_band" };
  const sameDay = businessIsoDate(current.start) === day;
  if (covers(current, day, band)) {
    if (sameDay && !leadChanges) {
      return { kind: "noop", coveredLine: !windowEqual(current, arrivalWindowUtcForBusinessDate(day, band)) };
    }
    return { kind: "keep" };
  }
  const offerKeep = !sameDay || leadChanges;
  const kind = currentWindowKind(current.start, current.end);
  return { kind: "prompt", defaultChoice: kind === "band" || !offerKeep ? "match" : "keep", offerKeep };
}

/** The window a move writes. `keep` with no window and `pick` without a pick are not ok. */
export function resolveMoveWindow(
  current: TimeWindow | null,
  day: string,
  band: RescheduleWindowRow,
  rule: WindowRule,
  pick?: ArrivalWindow,
): ResolvedWindow {
  if (rule === "match") return { ok: true, ...arrivalWindowUtcForBusinessDate(day, band) };
  if (rule === "pick") return pick ? { ok: true, ...arrivalWindowUtcForBusinessDate(day, pick) } : { ok: false };
  if (!current) return { ok: false };
  return { ok: true, ...keepWindowOn(current, day) };
}

/** A window has ended once its end is at or before `now` (window-ended.ts semantics). */
export function windowHasEndedAt(window: TimeWindow, now: Date): boolean {
  return window.end.getTime() <= now.getTime();
}

/** Capacity-removing blocks of the checked technicians that overlap the window (half-open). */
export function timeOffHits(
  blocks: readonly BoardBlock[],
  technicianIds: readonly string[],
  window: TimeWindow,
): BoardBlock[] {
  const ids = new Set(technicianIds);
  return blocks.filter(
    (b) =>
      b.removesCapacity &&
      ids.has(b.technicianId) &&
      Date.parse(b.startsAt) < window.end.getTime() &&
      Date.parse(b.endsAt) > window.start.getTime(),
  );
}
