'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { CopySignInLink } from '@/components/admin/setup/copy-sign-in-link';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import { nextRows } from '@/lib/admin/setup-view';
import {
  cardFinished,
  cardHidden,
  cardLoadingView,
  readDemoFlags,
  writeDemoFlags,
  type CardSessionFlags,
} from '@/lib/admin/setup-card-view';
import type { DerivedStep } from '@/lib/admin/onboarding-steps';

const SKELETON_DELAY_MS = 300;
const WINS = ["Your technician can sign in", 'Your first request is booked', "It's on a technician's phone"];

function UpNext({ step }: { step: DerivedStep }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Up next</p>
      <p className="text-sm font-semibold text-foreground">{step.title}</p>
      <p className="text-[13px] text-muted-foreground">{step.why}</p>
      {step.action === 'copy_sign_in_link' && step.copyValue ? (
        <CopySignInLink url={step.copyValue} instruction={step.instruction ?? ''} />
      ) : step.href ? (
        <div>
          <Button className="w-full sm:w-auto" render={<Link href={step.href} />}>
            {step.hrefLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MoreRow({ step }: { step: DerivedStep }) {
  return (
    <li className="flex items-center gap-2 py-2.5">
      <span className="min-w-0 truncate text-[13px] text-foreground">{step.title}</span>
      {!step.required && <ContextBadge label="Optional" />}
    </li>
  );
}

/** Home "Setup guide" card (spec §2, §8): progress, Up next, two more rows, dismiss. */
export function SetupCard() {
  const { data, error } = useOnboarding();
  const [flags, setFlags] = useState<CardSessionFlags>({});
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    void refreshOnboarding();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is read after mount (no hydration mismatch)
    setFlags(readDemoFlags());
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const view = cardLoadingView(data, error, slow);
  if (view === 'nothing') return null;
  if (view === 'skeleton' || !data) {
    return (
      <SectionCard title="Setup guide">
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-8 w-36" />
        </div>
      </SectionCard>
    );
  }
  if (hidden || cardHidden(data, flags)) return null;

  const finished = cardFinished(data);

  async function acknowledge(): Promise<void> {
    if (!data) return;
    const key = finished ? 'completedSeen' : 'dismissed';
    setHidden(true);
    setFailed(false);
    try {
      if (data.demo) {
        const next = { ...flags, [key]: true };
        writeDemoFlags(next);
        setFlags(next);
      } else {
        const res = await adminFetch('/api/admin/onboarding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: true }),
        });
        if (!res.ok) throw new Error('onboarding PATCH failed');
      }
      await refreshOnboarding({ force: true });
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      setHidden(false);
      setFailed(true);
    }
  }

  const upNext = data.steps.find((s) => s.id === data.upNext);
  const more = nextRows(data, 3).filter((s) => s.id !== data.upNext).slice(0, 2);
  const { requiredDone, requiredTotal } = data.progress;

  return (
    <SectionCard
      title="Setup guide"
      meta={`${requiredDone} of ${requiredTotal}`}
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={finished ? 'Close the setup guide card' : 'Hide the setup guide from the home page'}
          onClick={() => void acknowledge()}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {finished ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-foreground">You&apos;re ready to run requests</p>
            <ul className="flex flex-col gap-1.5">
              {WINS.map((win) => (
                <li key={win} className="flex items-center gap-2 text-[13px] text-foreground">
                  <Check className="size-3.5 shrink-0 text-success-strong" aria-hidden="true" />
                  {win}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {upNext && <UpNext step={upNext} />}
            {more.length > 0 && (
              <ul className="divide-y divide-border border-t border-border">
                {more.map((s) => (
                  <MoreRow key={s.id} step={s} />
                ))}
              </ul>
            )}
          </>
        )}
        {failed && (
          <p role="alert" className="text-[13px] text-danger-strong">
            Couldn&apos;t update the setup guide. Please try again.
          </p>
        )}
        <Link href="/admin/setup" className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
          See all steps
        </Link>
      </div>
    </SectionCard>
  );
}
