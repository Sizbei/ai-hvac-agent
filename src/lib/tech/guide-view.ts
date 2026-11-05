import type { DerivedStep, GuidePayload } from "./guide-steps";
import type { StepId } from "./guide-state";
import { GUIDE_COPY } from "./guide-copy";

/** Pure view decisions for the guide card and page (spec §6). No DOM. */

export type TodayFirst = { href: string } | null | "unknown";
export type CardState = "nothing" | "skeleton" | "card" | "finished" | "hidden";
export type Glyph = "done" | "next" | "todo";

export function cardState(
  payload: GuidePayload | null,
  o: { loading: boolean; failed: boolean; slowElapsed: boolean; guideHidden: boolean; todaySettled: boolean },
): CardState {
  if (o.guideHidden || payload?.cardHidden) return "hidden";
  if (!payload) {
    if (o.failed) return "nothing";
    return o.slowElapsed ? "skeleton" : "nothing";
  }
  if (!o.todaySettled) return o.slowElapsed ? "skeleton" : "nothing";
  return payload.finished ? "finished" : "card";
}

const ACTIVE = new Set(["in_progress", "arrived", "en_route"]);

/** The Today row the card's button opens: an active row first, else the first row. */
export function pickTodayFirst(rows: ReadonlyArray<{ id: string; appointmentId: string; assignmentStatus: string }>): { href: string } | null {
  const row = rows.find((r) => ACTIVE.has(r.assignmentStatus)) ?? rows[0];
  return row ? { href: `/tech/jobs/${row.id}?visit=${row.appointmentId}` } : null;
}

/** The server note wins; the Upcoming hint only when Today succeeded with no rows. */
export function cardNote(step: DerivedStep, hasOpenJob: boolean, todayFirst: TodayFirst): string | undefined {
  if (step.note) return step.note;
  if (step.id === "start_job" && hasOpenJob && todayFirst === null) return GUIDE_COPY.upcomingNote;
  return undefined;
}

export function glyphFor(step: Pick<DerivedStep, "id" | "done">, upNext: StepId | null): Glyph {
  if (step.done) return "done";
  return step.id === upNext ? "next" : "todo";
}
