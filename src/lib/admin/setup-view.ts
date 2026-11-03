/**
 * Pure view helpers shared by the setup page and the home card.
 */
import type { DerivedStep, OnboardingPayload } from "./onboarding-steps";
import type { StepId } from "./onboarding-state";

/** The setup step a deep-linked settings tab belongs to (spec §3). */
const SETUP_STEP_BY_TAB: Readonly<Record<string, StepId>> = {
  business: "phone_hours",
  branding: "brand",
  embed: "chat_widget",
};

/** Own keys only: `constructor`, `__proto__` and friends map to no step. */
export function setupStepForTab(tab: string): StepId | undefined {
  return Object.hasOwn(SETUP_STEP_BY_TAB, tab) ? SETUP_STEP_BY_TAB[tab] : undefined;
}

/**
 * The next `n` not-done steps in Up-next order (spec §4): required steps first
 * in step order, then optional steps in step order. Done steps are skipped.
 */
export function nextRows(payload: OnboardingPayload, n: number): DerivedStep[] {
  if (n <= 0) return [];
  const open = payload.steps.filter((s) => !s.done);
  return [...open.filter((s) => s.required), ...open.filter((s) => !s.required)].slice(0, n);
}

/** A step as the page renders it: `number` is its 1-based display position. */
export interface StepRow {
  readonly step: DerivedStep;
  readonly number: number;
}

export interface PhaseGroup {
  readonly phase: 1 | 2 | 3;
  readonly title: string;
  readonly rows: readonly StepRow[];
  /** Required steps only ("1 of 1"); undefined for a phase without required steps. */
  readonly meta?: string;
  /** Every required step in the phase is done. */
  readonly collapsed: boolean;
}

export const PHASE_TITLES: Record<1 | 2 | 3, string> = {
  1: "Set up your company",
  2: "Get your team and prices in",
  3: "Run your first request",
};

const required = (p: OnboardingPayload) => p.steps.filter((s) => s.required);
const optional = (p: OnboardingPayload) => p.steps.filter((s) => !s.required);

/** The three phase cards (spec §4 "Progress numbers"); optional steps live in `optionalGroup`. */
export function phasesOf(payload: OnboardingPayload): PhaseGroup[] {
  const req = required(payload);
  return ([1, 2, 3] as const).map((phase) => {
    const rows = req
      .map((step, i) => ({ step, number: i + 1 }))
      .filter((r) => r.step.phase === phase);
    const done = rows.filter((r) => r.step.done).length;
    return {
      phase,
      title: PHASE_TITLES[phase],
      rows,
      meta: rows.length > 0 ? `${done} of ${rows.length}` : undefined,
      collapsed: rows.length > 0 && done === rows.length,
    };
  });
}

export function optionalMeta(payload: OnboardingPayload): string {
  const { optionalDone, optionalTotal } = payload.progress;
  return `Go further · ${optionalDone} of ${optionalTotal}`;
}

/** The "Optional" group below the phases, numbered after the required steps. */
export function optionalGroup(payload: OnboardingPayload): { rows: StepRow[]; meta: string } {
  const offset = required(payload).length;
  return {
    rows: optional(payload).map((step, i) => ({ step, number: offset + i + 1 })),
    meta: optionalMeta(payload),
  };
}

/** Hero slot: the first needs-attention step wins and suppresses Up next. */
export function heroFor(payload: OnboardingPayload): { attention?: DerivedStep; upNext?: DerivedStep } {
  const attention = payload.steps.find((s) => s.needsAttention);
  if (attention) return { attention };
  const next = payload.steps.find((s) => s.id === payload.upNext);
  return next ? { upNext: next } : {};
}

export function showFinished(payload: OnboardingPayload): boolean {
  const { requiredDone, requiredTotal } = payload.progress;
  return requiredDone === requiredTotal || payload.completedSeenAt != null;
}

const SUBTITLE_ACTIVE =
  "Finish these to run your first request. Steps complete on their own · about 10 min, plus your technician's sign-in";
const SUBTITLE_SETTLED = "Steps complete on their own.";
const DISMISSED_NOTE = "Hidden from the home page. Steps still complete on their own.";

export function subtitleFor(payload: OnboardingPayload): string {
  return payload.dismissedAt != null || payload.completedSeenAt != null
    ? SUBTITLE_SETTLED
    : SUBTITLE_ACTIVE;
}

export function dismissedNote(payload: OnboardingPayload): string | null {
  return payload.dismissedAt != null ? DISMISSED_NOTE : null;
}

/** Ids whose `done` flipped false → true between two snapshots (none on first load). */
export function justDone(prev: OnboardingPayload | null, next: OnboardingPayload): string[] {
  if (!prev) return [];
  const wasDone = new Map(prev.steps.map((s) => [s.id, s.done]));
  return next.steps.filter((s) => s.done && wasDone.get(s.id) === false).map((s) => s.id);
}

/**
 * Which links a row shows. The hero repeats only the primary action, so the
 * hero step's row hides the primary but keeps its secondary link (§3).
 */
export function rowActionsFor(
  step: DerivedStep,
  heroId: string | undefined,
): { primary: boolean; secondary: boolean } {
  if (step.done) return { primary: false, secondary: false };
  return {
    primary: step.id !== heroId,
    secondary: Boolean(step.secondaryHref && step.secondaryLabel),
  };
}
