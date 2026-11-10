'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/admin/ui/error-state';
import { PageHeader } from '@/components/admin/ui/page-header';
import { PageShell } from '@/components/admin/ui/page-shell';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { SectionCard } from '@/components/admin/ui/section-card';
import { SetupFinished } from '@/components/admin/setup/setup-finished';
import { QuickTourSection } from '@/components/admin/setup/quick-tour-section';
import { SetupHero } from '@/components/admin/setup/setup-hero';
import { SetupPhaseCard, StepList } from '@/components/admin/setup/setup-phase-card';
import { useQuickTour } from '@/hooks/use-quick-tour';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import type { DerivedStep, OnboardingPayload } from '@/lib/admin/onboarding-steps';
import {
  dismissedNote,
  heroFor,
  justDone,
  optionalGroup,
  PHASE_TITLES,
  phasesOf,
  showFinished,
  subtitleFor,
} from '@/lib/admin/setup-view';
import { showTourInvite } from '@/lib/admin/tour-view';

const SKELETON_DELAY_MS = 300;
const TITLE = 'Setup guide';

function SetupSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      {([1, 2, 3] as const).map((phase) => (
        <SectionCard key={phase} title={PHASE_TITLES[phase]}>
          <div className="space-y-4">
            {Array.from({ length: phase + 1 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-6 shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-56 max-w-full" />
                  <Skeleton className="h-3 w-80 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

interface HeroView {
  readonly step: DerivedStep | undefined;
  readonly number: number;
  readonly attention: boolean;
}

function heroView(data: OnboardingPayload): HeroView {
  const hero = heroFor(data);
  const rows = [...phasesOf(data).flatMap((p) => p.rows), ...optionalGroup(data).rows];
  const step = hero.attention ?? (showFinished(data) ? undefined : hero.upNext);
  const number = rows.find((r) => r.step.id === step?.id)?.number ?? 1;
  return { step, number, attention: Boolean(hero.attention) };
}

function SetupContent({
  data,
  flipped,
  heroId,
}: {
  data: OnboardingPayload;
  flipped: ReadonlySet<string>;
  heroId: string | undefined;
}) {
  const finished = showFinished(data);
  const phases = phasesOf(data);
  const optional = optionalGroup(data);

  return (
    <>
      {finished && <SetupFinished optionalRows={optional.rows} optionalMeta={optional.meta} justDone={flipped} />}
      {phases.map((p) => (
        <SetupPhaseCard
          key={p.phase}
          title={p.title}
          meta={p.meta}
          rows={p.rows}
          collapsed={p.collapsed}
          justDone={flipped}
          heroId={heroId}
        />
      ))}
      {!finished && (
        <SectionCard title="Optional" meta={optional.meta}>
          <StepList rows={optional.rows} justDone={flipped} heroId={heroId} />
        </SectionCard>
      )}
    </>
  );
}

/** Header line (onboarding spec D3): jumps to the tour section. */
function TourInvite() {
  return (
    <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
      New here?{' '}
      <a href="#learn" className="font-medium text-link underline-offset-4 hover:underline">
        Take the quick tour
      </a>
    </p>
  );
}

function SetupHeader({ data, invite }: { data: OnboardingPayload | null; invite: boolean }) {
  if (!data) {
    return (
      <div>
        <PageHeader title={TITLE} />
        {invite && <TourInvite />}
      </div>
    );
  }
  const { requiredDone, requiredTotal } = data.progress;
  const note = dismissedNote(data);
  return (
    <div>
      <PageHeader title={TITLE} subtitle={subtitleFor(data)} />
      {invite && <TourInvite />}
      {note && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-[13px] leading-5 text-muted-foreground">{note}</p>
          <ShowOnHomeButton />
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <ProgressBar
          value={requiredDone}
          max={requiredTotal}
          label="Required setup steps done"
          className="min-w-0 max-w-48 flex-1"
        />
        <span className="shrink-0 font-mono text-[13px] tabular-nums text-foreground">
          {requiredDone} of {requiredTotal}
        </span>
      </div>
    </div>
  );
}

/**
 * Undo "Hide the setup guide from the home page": brings back the home card,
 * and (via router.refresh, the placement is computed in the server layout)
 * the Setup item's place under Operations.
 */
function ShowOnHomeButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function show(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const res = await adminFetch('/api/admin/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showOnHome: true }),
      });
      if (!res.ok) throw new Error('onboarding PATCH failed');
      await refreshOnboarding({ force: true });
      router.refresh();
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void show()}>
        {busy ? 'Showing…' : 'Show on home page'}
      </Button>
      {failed && (
        <span role="alert" className="text-[13px] text-destructive">
          Couldn&apos;t show the guide. Please try again.
        </span>
      )}
    </span>
  );
}

/**
 * `/admin/setup` (spec §8): hero, three phases, optional steps; all derived
 * server-side. One tree for every state (loading, error, data) so the quick
 * tour (onboarding spec D3) mounts once.
 */
export function SetupPageClient() {
  const { data, error } = useOnboarding();
  const [slow, setSlow] = useState(false);
  // Previous snapshot kept in state (render-time adjustment) to diff `done` flips.
  const [prev, setPrev] = useState<OnboardingPayload | null>(data);
  const [flippedIds, setFlippedIds] = useState<readonly string[]>([]);
  if (data !== prev) {
    // Keep the last flip until another step flips, so a plain refresh does not
    // snap a just-completed phase shut.
    const next = data ? justDone(prev, data) : [];
    if (next.length > 0) setFlippedIds(next);
    setPrev(data);
  }
  const flipped = useMemo(() => new Set(flippedIds), [flippedIds]);

  useEffect(() => {
    void refreshOnboarding();
  }, []);

  useEffect(() => {
    if (data) return;
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, [data]);

  const tour = useQuickTour(data, error);
  const { mount } = tour;
  const tourAbove = mount?.placement === 'above';
  // Rendered in exactly one of two fixed slots, chosen once at mount, so the
  // tour never remounts when the checklist data or an error arrives.
  const tourSection = mount && <QuickTourSection tour={{ ...tour, mount }} slow={slow} />;
  const hero = data ? heroView(data) : null;

  let primary: React.ReactNode = null;
  if (hero?.step) {
    primary = (
      <SetupHero
        step={hero.step}
        number={hero.number}
        attention={hero.attention}
        actionVariant={tourAbove && tour.progress && !tour.progress.completed ? 'outline' : 'default'}
      />
    );
  } else if (!data && error) {
    primary = (
      <ErrorState
        title="Couldn't load the setup guide"
        description="Please try again."
        action={
          <Button variant="outline" onClick={() => void refreshOnboarding({ force: true })}>
            Try again
          </Button>
        }
      />
    );
  } else if (!data && slow) {
    primary = <SetupSkeleton />;
  }

  return (
    <PageShell narrow>
      <SetupHeader data={data} invite={mount !== null && showTourInvite(mount, tour.progress)} />
      {tourAbove && tourSection}
      {primary}
      {!tourAbove && tourSection}
      {data && <SetupContent data={data} flipped={flipped} heroId={hero?.step?.id} />}
    </PageShell>
  );
}
