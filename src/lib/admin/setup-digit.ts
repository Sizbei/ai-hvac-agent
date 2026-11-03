/**
 * Sidebar digit on the Setup nav item (spec §2): the required steps not done.
 * Pure so it unit-tests without React. Hidden until loaded, when 0, and always
 * after `dismissedAt`; after `completedSeenAt` it shows only the steps that
 * need attention.
 */
import type { OnboardingPayload } from "./onboarding-steps";

export interface SetupDigit {
  readonly visible: boolean;
  readonly label: string;
  readonly srLabel: string;
}

const HIDDEN: SetupDigit = { visible: false, label: "", srLabel: "" };

export function setupDigit({ data }: { data: OnboardingPayload | null }): SetupDigit {
  if (!data || data.dismissedAt) return HIDDEN;
  if (data.completedSeenAt) {
    const n = data.steps.filter((s) => s.needsAttention).length;
    if (n === 0) return HIDDEN;
    const sr = n === 1 ? "1 setup step needs attention" : `${n} setup steps need attention`;
    return { visible: true, label: String(n), srLabel: sr };
  }
  const n = Math.max(0, data.progress.requiredTotal - data.progress.requiredDone);
  if (n === 0) return HIDDEN;
  const sr = n === 1 ? "1 setup step left" : `${n} setup steps left`;
  return { visible: true, label: String(n), srLabel: sr };
}
