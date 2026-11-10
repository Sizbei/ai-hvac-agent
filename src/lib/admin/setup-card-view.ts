/**
 * Pure view helpers for the home Setup guide card and the "Back to guide"
 * banner (spec §2, §4). Types only from the onboarding modules.
 */
import type { DerivedStep, OnboardingPayload } from "./onboarding-steps";
import type { SetupPlacement } from "@/components/admin/nav-items";

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

export type CardView = "nothing" | "skeleton" | "welcome-only" | "full" | "finished";

export interface CardState {
  readonly view: CardView;
  /** The per-user welcome row shows on top of the card. */
  readonly welcome: boolean;
}

/**
 * The card's state (onboarding spec D2 table). Without data: nothing under
 * 300 ms, then a skeleton, and nothing after an error or under Integrations
 * placement (a dismissed or finished org never sees a skeleton flash). With
 * data: as before when no welcome is due; a due welcome rides on top of the
 * full or finished card, or stands alone ("welcome-only") when the checklist
 * card would be hidden.
 */
export function cardView({
  data,
  error,
  slow,
  placement,
  demoFlags,
}: {
  data: OnboardingPayload | null;
  error: boolean;
  slow: boolean;
  placement: SetupPlacement;
  demoFlags: CardSessionFlags;
}): CardState {
  if (!data) {
    const skeleton = placement === "operations" && slow && !error;
    return { view: skeleton ? "skeleton" : "nothing", welcome: false };
  }
  const welcome = data.guide?.welcomeDue === true;
  if (placement !== "operations" || cardHidden(data, demoFlags)) {
    return welcome ? { view: "welcome-only", welcome } : { view: "nothing", welcome };
  }
  return { view: cardFinished(data) ? "finished" : "full", welcome };
}

export function cardTitle(view: CardView): string {
  return view === "welcome-only" ? "Getting started" : "Setup guide";
}

export type UpNextAction =
  | { readonly kind: "copy"; readonly url: string; readonly variant: "outline" | "default" }
  | { readonly kind: "instruction" }
  | { readonly kind: "link"; readonly href: string; readonly label: string; readonly variant: "outline" | "default" }
  | { readonly kind: "none" };

/**
 * Up next's action. Every button kind takes `variant`, so while the welcome
 * shows the card keeps one primary (the copy step included).
 */
export function upNextAction(step: DerivedStep, variant: "outline" | "default"): UpNextAction {
  if (step.action === "copy_sign_in_link" && step.copyValue) {
    return { kind: "copy", url: step.copyValue, variant };
  }
  if (step.instruction) return { kind: "instruction" };
  if (step.href) return { kind: "link", href: step.href, label: step.hrefLabel, variant };
  return { kind: "none" };
}

/** The unacknowledged finishing moment (spec §4 "Finishing moment"). */
export function cardFinished(payload: OnboardingPayload): boolean {
  const { requiredDone, requiredTotal } = payload.progress;
  return requiredDone === requiredTotal && payload.completedSeenAt == null;
}

/** Banner copy, precedence top-down: done → invite → saved with note → title. */
export function bannerText(step: DerivedStep | undefined, event: BannerEvent): string {
  if (step?.done) return BANNER_DONE;
  if (event === "invite") return BANNER_INVITE;
  if (!step) return "Setup guide";
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
