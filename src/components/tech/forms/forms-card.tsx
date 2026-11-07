'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { fillHref, formChips } from '@/lib/tech/form-copy';
import type { TechFormsView } from '@/lib/tech/form-view';

const FILTER_FROM = 10;

/**
 * The job page's Forms card, directly after the summary (M3d spec §7.2): the
 * visit's forms with their chips, `Add a form` for writers. Refetches when
 * `refreshKey` changes (a status tap) and when the tab becomes visible.
 */
export function FormsCard({
  jobId,
  visitId,
  refreshKey,
  summaryFailed = false,
  onLoaded,
}: {
  readonly jobId: string;
  /** The job summary failed to load, so the visit is unknown: show the error state, not a skeleton forever. */
  readonly summaryFailed?: boolean;
  /** undefined while the job summary is still loading. */
  readonly visitId: string | null | undefined;
  readonly refreshKey: number;
  readonly onLoaded?: (view: TechFormsView | null) => void;
}) {
  const [view, setView] = useState<TechFormsView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  const load = useCallback(async () => {
    if (!visitId) return;
    try {
      const res = await fetch(`/api/tech/jobs/${jobId}/forms?visit=${visitId}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setView(body.data as TechFormsView);
        setState('ok');
        onLoadedRef.current?.(body.data as TechFormsView);
      } else {
        setState('error');
        onLoadedRef.current?.(null);
      }
    } catch {
      setState('error');
    }
  }, [jobId, visitId]);

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

  const others = view?.otherForms ?? [];
  const shownOthers = filter.trim()
    ? others.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : others;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-[17px]">
          Forms{view && view.visitNumber > 1 ? <span className="font-normal text-muted-foreground"> · Visit #{view.visitNumber}</span> : null}
        </CardTitle>
        {view?.canWrite && (
          <Button variant="outline" className="h-11 rounded-xl px-3 text-[15px]" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" /> Add a form
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {visitId === undefined && summaryFailed ? (
          <p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load forms.</p>
        ) : visitId === undefined ? (
          <Skeleton className="h-12 w-full" />
        ) : visitId === null ? (
          <p className="text-[15px] text-muted-foreground">No visit on this job yet.</p>
        ) : state === 'loading' ? (
          <Skeleton className="h-12 w-full" />
        ) : state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">
            Couldn&apos;t load forms.{' '}
            <button type="button" className="min-h-11 underline" onClick={() => void load()}>Try again</button>
          </p>
        ) : view.forms.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">No forms for this job.</p>
        ) : (
          <ul className="divide-y">
            {view.forms.map((f) => {
              const chips = formChips(f);
              return (
                <li key={f.formId}>
                  <Link href={fillHref(jobId, f.formId, view.visitId)} className="flex min-h-11 items-center gap-2 py-2.5 text-[15px] active:bg-accent">
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block font-medium">{f.name}</span>
                      <span className="flex flex-wrap gap-1.5">
                        <span className="rounded-[3px] border px-1.5 py-0.5 text-[13px]">{chips.status}</span>
                        {chips.required && chips.status !== 'Submitted' && (
                          <span className="rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[13px] text-warning-strong">Required</span>
                        )}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent side="bottom" className="max-h-[88dvh] gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Add a form</SheetTitle>
          </SheetHeader>
          <div className="space-y-2 overflow-y-auto px-4">
            {others.length > FILTER_FROM && (
              <Input placeholder="Filter forms…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-11 rounded-xl text-[15px] md:text-[15px]" />
            )}
            {shownOthers.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No other forms.</p>
            ) : (
              <ul className="divide-y">
                {shownOthers.map((o) => (
                  <li key={o.formId}>
                    <Link href={view ? fillHref(jobId, o.formId, view.visitId) : '#'} className="flex min-h-11 items-center py-2.5 text-[15px] active:bg-accent">
                      {o.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
