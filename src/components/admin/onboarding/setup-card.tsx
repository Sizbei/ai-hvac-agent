'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { CopySignInLink } from '@/components/admin/setup/copy-sign-in-link';
import { useSetupPlacement } from '@/components/admin/setup-placement-context';
import { useOrgName } from '@/components/admin/org-name-context';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import { patchGuide } from '@/lib/admin/guide-patch';
import { nextRows, requiredMeta } from '@/lib/admin/setup-view';
import {
  cardTitle,
  cardView,
  skeletonTitle,
  upNextAction,
  readDemoFlags,
  writeDemoFlags,
  type CardSessionFlags,
} from '@/lib/admin/setup-card-view';
import { welcomeDismissBody, welcomeRowView, type WelcomeRowView } from '@/lib/admin/welcome-view';
import type { DerivedStep, OnboardingPayload } from '@/lib/admin/onboarding-steps';

const SKELETON_DELAY_MS = 300;
const WINS = ["Your technician can sign in", 'Your first request is booked', "It's on a technician's phone"];

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** After "Not now": the next focusable element in the card, else the page h1. */
function focusAfterWelcome(body: HTMLElement | null): void {
  const next = body?.querySelector<HTMLElement>(FOCUSABLE);
  if (next) {
    next.focus();
    return;
  }
  const h1 = document.querySelector<HTMLElement>('main h1');
  if (!h1) return;
  if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
  h1.focus();
}

/** The payload as this card shows it: "Not now" hides the welcome locally. */
function withWelcomeHidden(data: OnboardingPayload | null, hidden: boolean): OnboardingPayload | null {
  if (!hidden || !data?.guide) return data;
  return { ...data, guide: { ...data.guide, welcomeDue: false } };
}

function WelcomeRow({
  row,
  divided,
  onNotNow,
}: {
  row: WelcomeRowView;
  divided: boolean;
  onNotNow: () => void;
}) {
  return (
    <div className={divided ? 'flex flex-col gap-2 border-b border-border pb-4' : 'flex flex-col gap-2'}>
      <h3 className="text-sm font-semibold text-foreground">{row.title}</h3>
      <p className="text-[13px] text-muted-foreground">{row.line}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 pt-1">
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 sm:w-auto">
          <Link href={row.primary.href} className={buttonVariants({ className: 'w-full sm:w-auto' })}>
            {row.primary.label}
          </Link>
          {row.meta && (
            <span className="font-mono text-[13px] tabular-nums text-muted-foreground">{row.meta}</span>
          )}
        </div>
        <Button variant="ghost" className="w-full sm:w-auto" onClick={onNotNow}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function UpNext({ step, variant }: { step: DerivedStep; variant: 'outline' | 'default' }) {
  const action = upNextAction(step, variant);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Up next</p>
      <p className="text-sm font-semibold text-foreground">{step.title}</p>
      <p className="text-[13px] text-muted-foreground">{step.why}</p>
      {action.kind === 'copy' ? (
        <CopySignInLink url={action.url} instruction={step.instruction ?? ''} variant={action.variant} />
      ) : action.kind === 'instruction' ? (
        <p className="text-[13px] text-muted-foreground">{step.instruction}</p>
      ) : action.kind === 'link' ? (
        <div>
          <Link href={action.href} className={buttonVariants({ variant: action.variant, className: 'w-full sm:w-auto' })}>
            {action.label}
          </Link>
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

/**
 * Home "Setup guide" card (spec §2, §8; onboarding spec D2): the per-user
 * welcome row, progress, Up next, two more rows, dismiss.
 */
export function SetupCard() {
  const { data, error } = useOnboarding();
  const placement = useSetupPlacement();
  const orgName = useOrgName();
  const [flags, setFlags] = useState<CardSessionFlags>({});
  const [hidden, setHidden] = useState(false);
  const [welcomeHidden, setWelcomeHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  useEffect(() => {
    void refreshOnboarding();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is read after mount (no hydration mismatch)
    setFlags(readDemoFlags());
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  // Runs after the render that removed the welcome row.
  useEffect(() => {
    if (!welcomeHidden || !focusPending.current) return;
    focusPending.current = false;
    focusAfterWelcome(bodyRef.current);
  }, [welcomeHidden]);

  const shown = withWelcomeHidden(data, welcomeHidden);
  const state = cardView({ data: shown, error, slow, placement, demoFlags: flags });
  if (state.view === 'nothing' || hidden) return null;
  if (state.view === 'skeleton' || !shown) {
    return (
      <SectionCard title={skeletonTitle(flags)}>
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-8 w-36" />
        </div>
      </SectionCard>
    );
  }

  const payload = shown;
  const finished = state.view === 'finished';
  const welcome = welcomeRowView({ guide: payload.guide, orgName, cardState: state });

  async function acknowledge(): Promise<void> {
    const key = finished ? 'completedSeen' : 'dismissed';
    setHidden(true);
    setFailed(false);
    try {
      if (payload.demo) {
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

  // "Not now": hide at once; a failed PATCH keeps it hidden until the next load.
  // In preview (readOnly) nothing is written or refetched.
  async function notNow(): Promise<void> {
    const body = welcomeDismissBody(payload.guide);
    focusPending.current = true;
    setWelcomeHidden(true);
    if (!body) return;
    // The row stays hidden for this visit either way; refetch only after a stored write.
    if (await patchGuide(body)) await refreshOnboarding({ force: true });
  }

  const welcomeOnly = state.view === 'welcome-only';
  const upNext = payload.steps.find((s) => s.id === payload.upNext);
  const more = nextRows(payload, 3).filter((s) => s.id !== payload.upNext).slice(0, 2);

  return (
    <SectionCard
      title={cardTitle(state.view)}
      meta={welcomeOnly ? undefined : requiredMeta(payload)}
      action={
        welcomeOnly || welcome.hideCardDismiss ? undefined : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={finished ? 'Close the setup guide card' : 'Hide the setup guide from the home page'}
            onClick={() => void acknowledge()}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        )
      }
    >
      <div ref={bodyRef} className="flex flex-col gap-4">
        {welcome.show && <WelcomeRow row={welcome} divided={!welcomeOnly} onNotNow={() => void notNow()} />}
        {welcomeOnly ? null : finished ? (
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
            {upNext && <UpNext step={upNext} variant={welcome.upNextVariant} />}
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
        {!welcomeOnly && (
          <Link href="/admin/setup" className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
            See all steps
          </Link>
        )}
      </div>
    </SectionCard>
  );
}
