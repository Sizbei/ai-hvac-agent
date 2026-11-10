'use client';

import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/admin/admin-fetch';
import { LESSON_IDS, type GuidePatch, type LessonId } from '@/lib/admin/admin-guide-state';
import { refreshOnboarding } from '@/lib/admin/onboarding-store';
import type { OnboardingPayload } from '@/lib/admin/onboarding-steps';
import { buildLessons, lessonContext, type Lesson } from '@/lib/admin/tour-lessons';
import {
  readTourMount,
  seedTour,
  stopAnnouncement,
  TOUR_DONE_LINE,
  tourSearch,
  type TourMount,
  type TourProgress,
} from '@/lib/admin/tour-view';

export interface QuickTour {
  /** Null until the URL has been read after mount; then held. */
  readonly mount: TourMount | null;
  /** Null until the first onboarding response (data or error). */
  readonly progress: TourProgress | null;
  readonly lessons: readonly Lesson[];
  /** Polite live-region text; empty until the user changes stop. */
  readonly announcement: string;
  readonly go: (index: number) => void;
  readonly finish: () => void;
  readonly replay: () => void;
}

/** Fire-and-forget: every failure (auth redirect included) is ignored. */
function patchGuide(body: GuidePatch): Promise<void> {
  return adminFetch('/api/admin/guide', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** No navigation, no scroll, no remount (the repo's use-url-filter-sync pattern). */
function replaceTourUrl(next: { lesson: LessonId | null; replay: boolean }): void {
  const { pathname, search, hash } = window.location;
  window.history.replaceState(null, '', pathname + tourSearch(search, next) + hash);
}

/**
 * Quick tour state for /admin/setup (onboarding spec D3). Placement is read
 * from the URL once after mount; stop and completed are local, seeded once
 * from `guide`. Writes are skipped while previewing or when `guide` is null.
 */
export function useQuickTour(data: OnboardingPayload | null, error: boolean): QuickTour {
  const [mount, setMount] = useState<TourMount | null>(null);
  const [progress, setProgress] = useState<TourProgress | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const guide = data?.guide ?? null;
  const canWrite = guide !== null && !guide.readOnly;
  const lessons = buildLessons(lessonContext(guide));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL after mount
    setMount(readTourMount(window.location.search, window.location.hash));
  }, []);

  // Seed once, on the first response; later refreshes never move the tour.
  if (mount && progress === null && (data !== null || error)) {
    setProgress(seedTour(mount, guide));
    setReplaying(mount.replay);
  }

  const wroteMount = useRef(false);
  useEffect(() => {
    if (!progress || wroteMount.current) return;
    wroteMount.current = true;
    if (mount?.lesson && !progress.completed && canWrite) void patchGuide({ lesson: mount.lesson });
  }, [progress, mount, canWrite]);

  function go(index: number): void {
    const next = Math.min(LESSON_IDS.length - 1, Math.max(0, index));
    const lesson = LESSON_IDS[next];
    setProgress({ index: next, completed: false });
    replaceTourUrl({ lesson, replay: replaying });
    setAnnouncement(stopAnnouncement(next, lessons[next].title));
    if (canWrite) void patchGuide({ lesson });
  }

  function finish(): void {
    setProgress((p) => ({ index: p?.index ?? LESSON_IDS.length - 1, completed: true }));
    setReplaying(false);
    replaceTourUrl({ lesson: null, replay: false });
    setAnnouncement(TOUR_DONE_LINE.text);
    if (canWrite) void patchGuide({ tourCompleted: true }).then(() => refreshOnboarding({ force: true }));
  }

  function replay(): void {
    setProgress({ index: 0, completed: false });
    setReplaying(true);
    replaceTourUrl({ lesson: LESSON_IDS[0], replay: true });
    setAnnouncement(stopAnnouncement(0, lessons[0].title));
    if (canWrite) void patchGuide({ lesson: LESSON_IDS[0] });
  }

  return { mount, progress, lessons, announcement, go, finish, replay };
}
