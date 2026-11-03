/**
 * Pure view helpers shared by the setup page and the home card.
 */
import type { DerivedStep, OnboardingPayload } from "./onboarding-steps";

/**
 * The next `n` not-done steps in Up-next order (spec §4): required steps first
 * in step order, then optional steps in step order. Done steps are skipped.
 */
export function nextRows(payload: OnboardingPayload, n: number): DerivedStep[] {
  if (n <= 0) return [];
  const open = payload.steps.filter((s) => !s.done);
  return [...open.filter((s) => s.required), ...open.filter((s) => !s.required)].slice(0, n);
}
