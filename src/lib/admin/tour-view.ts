/**
 * Pure decisions for the quick tour on /admin/setup (onboarding spec D3):
 * where it sits (once, from the URL), which stop it starts on (once, from
 * `guide`), the URL it writes back, and its fixed copy.
 */
import { LESSON_IDS, type AdminGuidePayload, type LessonId } from "./admin-guide-state";

export const TOUR_LENGTH = LESSON_IDS.length;

/** Read from the URL once at mount, then held. */
export interface TourMount {
  /** A valid `?lesson`; an invalid one is ignored. */
  readonly lesson: LessonId | null;
  /** `?replay=1`: reopen a completed tour. */
  readonly replay: boolean;
  /** Above the hero when the URL names a lesson, else below it. Never changes. */
  readonly placement: "above" | "below";
  /** Scroll to and focus the section heading once it is ready (`?lesson` or `#learn`). */
  readonly focus: boolean;
}

/** Local display state; seeded once from `guide`, then driven by the user. */
export interface TourProgress {
  readonly index: number;
  readonly completed: boolean;
}

export function isLessonId(value: string | null): value is LessonId {
  return value !== null && (LESSON_IDS as readonly string[]).includes(value);
}

export function readTourMount(search: string, hash: string): TourMount {
  const params = new URLSearchParams(search);
  const raw = params.get("lesson");
  const lesson = isLessonId(raw) ? raw : null;
  return {
    lesson,
    replay: params.get("replay") === "1",
    placement: lesson ? "above" : "below",
    focus: lesson !== null || hash === "#learn",
  };
}

/**
 * The stop to show: `?lesson`, else `lastLesson` once the tour has started,
 * else stop 1. A completed tour collapses (it beats `?lesson`) unless the URL
 * says replay. With no guide nothing is known to be completed.
 */
export function seedTour(mount: TourMount, guide: AdminGuidePayload | null): TourProgress {
  const resume = guide?.tourStartedAt && guide.lastLesson ? guide.lastLesson : null;
  const lesson = mount.lesson ?? resume;
  return {
    index: lesson ? LESSON_IDS.indexOf(lesson) : 0,
    completed: Boolean(guide?.tourCompletedAt) && !mount.replay,
  };
}

/**
 * Seed only from a response loaded after this mount: wait for the mount's
 * refresh to settle, so a cached snapshot (an old `lastLesson`) never seeds.
 * A settled failure with no data seeds the conservative tour.
 */
export function shouldSeedTour(s: {
  seeded: boolean;
  refreshSettled: boolean;
  hasData: boolean;
  error: boolean;
}): boolean {
  return !s.seeded && s.refreshSettled && (s.hasData || s.error);
}

/** "Show me" during a replay carries `replay=1` so the way back stays open. */
export function withReplay(href: string, replay: boolean): string {
  return replay ? `${href}${href.includes("?") ? "&" : "?"}replay=1` : href;
}

/** The search string for `history.replaceState`: other params kept; `lesson: null` removes both tour keys. */
export function tourSearch(search: string, next: { lesson: LessonId | null; replay: boolean }): string {
  const params = new URLSearchParams(search);
  params.delete("lesson");
  params.delete("replay");
  if (next.lesson) {
    params.set("lesson", next.lesson);
    if (next.replay) params.set("replay", "1");
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const stopLabel = (index: number): string => `Stop ${index + 1} of ${TOUR_LENGTH}`;

export const stopAnnouncement = (index: number, title: string): string => `${stopLabel(index)}: ${title}`;

export const TOUR_DONE_LINE = Object.freeze({ text: "You’ve seen the basics", action: "Replay tour" });

/** Header line "New here? Take the quick tour": once known, not completed, no `?lesson` at mount. */
export function showTourInvite(mount: TourMount, progress: TourProgress | null): boolean {
  return progress !== null && !progress.completed && mount.lesson === null;
}
