'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { CalendarDays, Check, Inbox, Receipt, Smartphone, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { IconChip } from '@/components/admin/ui/icon-chip';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { SectionCard } from '@/components/admin/ui/section-card';
import type { QuickTour } from '@/hooks/use-quick-tour';
import type { LessonId } from '@/lib/admin/admin-guide-state';
import { stopLabel, TOUR_DONE_LINE, TOUR_LENGTH, type TourMount } from '@/lib/admin/tour-view';

const TITLE = 'Quick tour';
const REPLAY_HREF = '/admin/setup?lesson=requests&replay=1#learn';

const LESSON_ICONS: Record<LessonId, LucideIcon> = {
  requests: Inbox,
  schedule: CalendarDays,
  technicians: Smartphone,
  customers: Users,
  paid: Receipt,
};

/** `arrive` scrolls the section to the top; `heading` only moves focus. */
type PendingFocus = 'arrive' | 'heading' | 'replay' | null;

interface QuickTourSectionProps {
  readonly tour: QuickTour & { readonly mount: TourMount };
  /** The page's 300 ms gate: no skeleton flash on a fast load. */
  readonly slow: boolean;
}

function TourSkeleton({ slow }: { slow: boolean }) {
  return (
    <SectionCard title={TITLE}>
      <div className="h-[118px] space-y-4" aria-hidden="true">
        {slow && (
          <>
            <Skeleton className="h-1 w-full" />
            <div className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-sm" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3 w-80 max-w-full" />
              </div>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Quick tour on /admin/setup (onboarding spec D3): five stops with Back /
 * Show me / Next, or the collapsed "You've seen the basics" line. Mounted once
 * by `SetupPageClient`; all state lives in `useQuickTour`.
 */
export function QuickTourSection({ tour, slow }: QuickTourSectionProps) {
  const { mount, progress, lessons, announcement } = tour;
  const sectionRef = useRef<HTMLElement>(null);
  const replayRef = useRef<HTMLAnchorElement>(null);
  const pendingFocus = useRef<PendingFocus>(mount.focus ? 'arrive' : null);
  const ready = progress !== null;
  const completed = progress?.completed ?? false;

  // Arrival (`?lesson` / `#learn`) and the Finish/Replay hand-offs; Back and
  // Next keep focus on the pressed button by themselves.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!ready || target === null) return;
    pendingFocus.current = null;
    if (target === 'replay') {
      replayRef.current?.focus();
      return;
    }
    const heading = sectionRef.current?.querySelector<HTMLElement>('h2');
    if (!heading) return;
    heading.tabIndex = -1;
    if (target === 'arrive') sectionRef.current?.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: target === 'arrive' });
  }, [ready, completed]);

  function finish(): void {
    pendingFocus.current = 'replay';
    tour.finish();
  }

  function replay(e: React.MouseEvent<HTMLAnchorElement>): void {
    e.preventDefault();
    pendingFocus.current = 'heading';
    tour.replay();
  }

  let body: React.ReactNode;
  if (!progress) {
    body = <TourSkeleton slow={slow} />;
  } else if (progress.completed) {
    body = (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-[13px] leading-5">
        <h2 className="sr-only">{TITLE}</h2>
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-success-strong" />
        <span className="text-foreground">{TOUR_DONE_LINE.text}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <a
          ref={replayRef}
          href={REPLAY_HREF}
          onClick={replay}
          className="rounded-sm font-medium text-link underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {TOUR_DONE_LINE.action}
        </a>
      </div>
    );
  } else {
    const { index } = progress;
    const lesson = lessons[index];
    const first = index === 0;
    const last = index === TOUR_LENGTH - 1;
    body = (
      <SectionCard title={TITLE} meta={stopLabel(index)}>
        <div className="space-y-4">
          <ProgressBar value={index + 1} max={TOUR_LENGTH} label="Quick tour progress" />
          <div className="flex gap-3">
            <IconChip icon={LESSON_ICONS[lesson.id]} intent="primary" />
            <div className="min-w-0 space-y-1">
              <p className="text-[16px] font-semibold leading-6 text-foreground">{lesson.title}</p>
              <p className="text-[13px] leading-5 text-muted-foreground">{lesson.copy}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              disabled={first}
              focusableWhenDisabled
              onClick={() => tour.go(index - 1)}
              className="data-[disabled]:opacity-50"
            >
              Back
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" render={<Link href={lesson.href} />}>
                Show me
              </Button>
              <Button onClick={last ? finish : () => tour.go(index + 1)}>{last ? 'Finish' : 'Next'}</Button>
            </div>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <section ref={sectionRef} id="learn" aria-label={TITLE} className="scroll-mt-6">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {body}
    </section>
  );
}
