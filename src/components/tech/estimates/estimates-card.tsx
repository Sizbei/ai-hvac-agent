'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BILLING_LINE, STATUS_CHIP, estimatesCardVisible, priceSummary, soldOptionOf } from '@/lib/tech/estimate-display';
import type { TechEstimate, TechEstimateStatus, TechEstimatesView } from '@/lib/tech/estimate-view';
import { fetchEstimates } from './fetch-estimates';

const CHIP_TONE: Record<TechEstimateStatus, string> = {
  open: 'border-border bg-surface-raised text-foreground',
  sold: 'border-success-border bg-success-light text-success-strong',
  expired: 'border-border bg-surface-raised text-muted-foreground',
  declined: 'border-border bg-surface-raised text-muted-foreground',
};

function RowBody({ e, showOption }: { readonly e: TechEstimate; readonly showOption: boolean }) {
  const sold = e.status === 'sold' ? soldOptionOf(e) : null;
  return (
    <span className="min-w-0 flex-1 space-y-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium">{e.label}</span>
        <span className={`rounded-[3px] border px-1.5 py-0.5 text-[13px] font-medium ${CHIP_TONE[e.status]}`}>{STATUS_CHIP[e.status]}</span>
      </span>
      <span className="block font-mono text-[14px] tabular-nums">{priceSummary(e)}</span>
      {e.status === 'sold' && (
        <span className="block text-[13px] text-muted-foreground">
          {showOption && sold ? `${sold.name} · ` : ''}{BILLING_LINE[e.billing]}
        </span>
      )}
    </span>
  );
}

/**
 * The job page's Estimates card (M3c spec §2): native estimates newest first,
 * the lead's New estimate (or why not), helpers read-only. Refetches when
 * `refreshKey` changes (a status tap) and when the tab becomes visible.
 */
export function EstimatesCard({
  jobId,
  refreshKey,
  onLoaded,
}: {
  readonly jobId: string;
  readonly refreshKey: number;
  readonly onLoaded?: (view: TechEstimatesView | null) => void;
}) {
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');

  const load = useCallback(async () => {
    const r = await fetchEstimates(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setState('ok');
      onLoaded?.(r.view);
    } else if (r.kind === 'hidden') {
      setState('hidden');
      onLoaded?.(null);
    } else {
      setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [jobId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  // Nothing until the first answer: on a job before arrival the card would
  // otherwise flash a skeleton and then hide (review spec m11).
  if (state === 'loading' || state === 'hidden' || (view && !estimatesCardVisible(view))) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Estimates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this job&apos;s estimates.</p>
        ) : (
          <>
            {view.estimates.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No estimates on this job yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Estimates">
                {view.estimates.map((e) => (
                  <li key={e.id}>
                    {view.isLead ? (
                      <Link href={`/tech/jobs/${jobId}/estimates/${e.id}`} className="flex min-h-11 items-center gap-2 py-2 active:bg-accent">
                        <RowBody e={e} showOption={false} />
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    ) : (
                      <div className="flex min-h-11 items-center gap-2 py-2">
                        <RowBody e={e} showOption />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {view.isLead && (view.canCreate ? (
              <Link
                href={`/tech/jobs/${jobId}/estimates/new`}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium active:bg-accent"
              >
                <Plus className="size-4" aria-hidden /> New estimate
              </Link>
            ) : (
              view.createBlockedReason && <p className="text-[15px] text-muted-foreground">{view.createBlockedReason}</p>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
