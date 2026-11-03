/**
 * Pure view helpers for the home Setup guide card and the "Back to guide"
 * banner (spec §2, §4). Types only from the onboarding modules.
 */
import type { DerivedStep, OnboardingPayload } from "./onboarding-steps";

/** Demo org acknowledgements kept in `sessionStorage` (no write ever persists). */
export interface CardSessionFlags {
  readonly dismissed?: boolean;
  readonly completedSeen?: boolean;
}

export type BannerEvent = "saved" | "invite" | null;

export const BANNER_DONE = "Done";
const BANNER_INVITE = "Invite created. This step completes when they accept it";
const BANNER_REQUEST_SAVED =
  "Saved. Pick a time and a technician on that request to finish this step";

export function cardHidden(
  payload: OnboardingPayload | null,
  flags: CardSessionFlags,
): boolean {
  if (!payload) return true;
  if (payload.dismissedAt != null || payload.completedSeenAt != null) return true;
  return payload.demo && (flags.dismissed === true || flags.completedSeen === true);
}

/** The unacknowledged finishing moment (spec §4 "Finishing moment"). */
export function cardFinished(payload: OnboardingPayload): boolean {
  const { requiredDone, requiredTotal } = payload.progress;
  return requiredDone === requiredTotal && payload.completedSeenAt == null;
}

/** Banner copy, precedence top-down: invite → done → saved with note → title. */
export function bannerText(step: DerivedStep | undefined, event: BannerEvent): string {
  if (event === "invite") return BANNER_INVITE;
  if (!step) return "Setup guide";
  if (step.done) return BANNER_DONE;
  if (event === "saved" && step.note) {
    return step.id === "book_first_request" ? BANNER_REQUEST_SAVED : `Saved. ${step.note}`;
  }
  return `Setup guide: ${step.title}`;
}

const DEMO_KEY = "onboarding-demo";

/** Demo acknowledgements from `sessionStorage`; any failure reads as none. */
export function readDemoFlags(): CardSessionFlags {
  try {
    const raw = window.sessionStorage.getItem(DEMO_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    const p = parsed as Record<string, unknown>;
    return { dismissed: p.dismissed === true, completedSeen: p.completedSeen === true };
  } catch {
    return {};
  }
}

export function writeDemoFlags(flags: CardSessionFlags): void {
  try {
    window.sessionStorage.setItem(DEMO_KEY, JSON.stringify(flags));
  } catch {
    // Storage blocked: the card's local hide still holds for this visit.
  }
}
