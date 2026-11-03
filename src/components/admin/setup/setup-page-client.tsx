'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/admin/ui/error-state';
import { PageHeader } from '@/components/admin/ui/page-header';
import { PageShell } from '@/components/admin/ui/page-shell';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { SectionCard } from '@/components/admin/ui/section-card';
import { SetupFinished } from '@/components/admin/setup/setup-finished';
import { SetupHero } from '@/components/admin/setup/setup-hero';
import { SetupPhaseCard, StepList } from '@/components/admin/setup/setup-phase-card';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import type { OnboardingPayload } from '@/lib/admin/onboarding-steps';
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

function SetupContent({ data, flipped }: { data: OnboardingPayload; flipped: ReadonlySet<string> }) {
  const hero = heroFor(data);
  const finished = showFinished(data);
  const phases = phasesOf(data);
  const optional = optionalGroup(data);
  const rows = [...phases.flatMap((p) => p.rows), ...optional.rows];
  const numberOf = (id: string) => rows.find((r) => r.step.id === id)?.number ?? 1;
  const heroStep = hero.attention ?? (finished ? undefined : hero.upNext);

  return (
    <>
      {heroStep && <SetupHero step={heroStep} number={numberOf(heroStep.id)} attention={Boolean(hero.attention)} />}
      {finished && <SetupFinished optionalRows={optional.rows} optionalMeta={optional.meta} justDone={flipped} />}
      {phases.map((p) => (
        <SetupPhaseCard
          key={p.phase}
          title={p.title}
          meta={p.meta}
          rows={p.rows}
          collapsed={p.collapsed}
          justDone={flipped}
          heroId={heroStep?.id}
        />
      ))}
      {!finished && (
        <SectionCard title="Optional" meta={optional.meta}>
          <StepList rows={optional.rows} justDone={flipped} heroId={heroStep?.id} />
        </SectionCard>
      )}
    </>
  );
}

/** `/admin/setup` (spec §8): hero, three phases, optional steps; all derived server-side. */
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

  if (!data) {
    return (
      <PageShell narrow>
        <PageHeader title={TITLE} />
        {error ? (
          <ErrorState
            title="Couldn't load the setup guide"
            description="Please try again."
            action={
              <Button variant="outline" onClick={() => void refreshOnboarding({ force: true })}>
                Try again
              </Button>
            }
          />
        ) : (
          slow && <SetupSkeleton />
        )}
      </PageShell>
    );
  }

  const { requiredDone, requiredTotal } = data.progress;
  const note = dismissedNote(data);
  return (
    <PageShell narrow>
      <div>
        <PageHeader title={TITLE} subtitle={subtitleFor(data)} />
        {note && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{note}</p>}
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
      <SetupContent data={data} flipped={flipped} />
    </PageShell>
  );
}
