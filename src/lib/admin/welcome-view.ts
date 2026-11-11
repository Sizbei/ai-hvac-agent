/**
 * Welcome row in the home Setup guide card (onboarding spec D2). Pure; type
 * imports only, plus the zod-free lesson list.
 */
import type { AdminGuidePayload } from "./admin-guide-state";
import { LESSON_IDS, type LessonId } from "./lesson-ids";
import type { CardState } from "./setup-card-view";

export interface WelcomeRowView {
  readonly show: boolean;
  readonly title: string;
  readonly line: string;
  /** "Stop {n} of 5" once the tour has started, else null. */
  readonly meta: string | null;
  readonly primary: { readonly label: string; readonly href: string };
  /** While the welcome shows, "Not now" is the card's only dismiss. */
  readonly hideCardDismiss: boolean;
  /** While the welcome shows, its button is the card's only primary. */
  readonly upNextVariant: "outline" | "default";
}

const TOUR_TAIL = "Here’s a quick tour of where things live.";

function tourHref(lesson: LessonId): string {
  return `/admin/setup?lesson=${lesson}#learn`;
}

const HIDDEN: WelcomeRowView = {
  show: false,
  title: "",
  line: "",
  meta: null,
  primary: { label: "Take the tour", href: tourHref("requests") },
  hideCardDismiss: false,
  upNextVariant: "default",
};

function welcomeLine(guide: AdminGuidePayload): string {
  if (guide.hasFieldPulse) return `Your FieldPulse jobs, customers and team, in one place. ${TOUR_TAIL}`;
  return `Your jobs, customers and team, in one place. ${TOUR_TAIL}`;
}

export function welcomeRowView({
  guide,
  orgName,
  cardState,
}: {
  guide: AdminGuidePayload | null;
  orgName: string | undefined;
  cardState: CardState;
}): WelcomeRowView {
  if (!guide || !cardState.welcome) return HIDDEN;
  const name = orgName?.trim();
  const started = guide.tourStartedAt !== null;
  const lesson = guide.lastLesson ?? "requests";
  return {
    show: true,
    title: name ? `Welcome to ${name}` : "Welcome",
    line: welcomeLine(guide),
    meta: started ? `Stop ${LESSON_IDS.indexOf(lesson) + 1} of ${LESSON_IDS.length}` : null,
    primary: started
      ? { label: "Continue the tour", href: tourHref(lesson) }
      : { label: "Take the tour", href: tourHref("requests") },
    hideCardDismiss: true,
    upNextVariant: "outline",
  };
}

/** "Not now" body, or null when nothing may be written (preview, no guide). */
export function welcomeDismissBody(guide: AdminGuidePayload | null): { dismissWelcome: true } | null {
  if (!guide || guide.readOnly) return null;
  return { dismissWelcome: true };
}
