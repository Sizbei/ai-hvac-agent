'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import {
  CUSTOMER_HASH, LAYER_CLOSED, approveFirst, layerStale, layerStep, pageLocked, saleFailNote, sellAdvanced, techNoteVisible,
  type LayerEffect, type LayerEvent, type LayerState,
} from '@/lib/tech/customer-view-state';
import { DECLINE_COPY, SOLD_ACTIONS, afterCheck, approvedLine } from '@/lib/tech/estimate-page-copy';
import { BILLING_LINE, SOLD_COPY, STATUS_CHIP, canSell, soldBillingView, soldOptionOf } from '@/lib/tech/estimate-display';
import { ESTIMATE_INTENT, MAY_NOT_HAVE_SAVED, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import type { TechEstimate, TechEstimateOption, TechEstimatesView } from '@/lib/tech/estimate-view';
import { CustomerView } from './customer-view';
import { fetchEstimates } from './fetch-estimates';
import { recoverEstimateIntents } from './recover-intents';
import { useEstimateWrite } from './use-estimate-write';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MONEY = 'font-mono tabular-nums';

function findEstimate(view: TechEstimatesView | null, eid: string): TechEstimate | null {
  return view?.estimates.find((x) => x.id === eid) ?? null;
}

function runEffect(effect: LayerEffect): void {
  const strip = () => window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (effect === 'push') window.history.pushState(null, '', CUSTOMER_HASH);
  else if (effect === 'back') window.history.back();
  else if (effect === 'strip') strip();
  else if (effect === 'strip_push') {
    // A reload reopened the layer: give it its own entry so Back closes it (plan ruling 13).
    strip();
    window.history.pushState(null, '', CUSTOMER_HASH);
  }
}

function OptionBlock({ o }: { readonly o: TechEstimateOption }) {
  return (
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label={o.name}>
      <h3 className="text-[15px] font-semibold">{o.name}</h3>
      <ul className="space-y-1">
        {o.lines.map((l) => (
          <li key={l.id} className="flex items-baseline justify-between gap-3 text-[15px]">
            <span className="min-w-0 break-words">{l.name} <span className={`${MONEY} text-[13px] text-muted-foreground`}>{l.quantity} × {formatCentsExact(l.unitPriceCents)}</span></span>
            <span className={MONEY}>{formatCentsExact(l.lineTotalCents)}</span>
          </li>
        ))}
      </ul>
      <p className={`${MONEY} text-[13px] text-muted-foreground`}>
        Subtotal {formatCentsExact(o.subtotalCents)} · Tax {formatCentsExact(o.taxCents)} · Total {formatCentsExact(o.totalCents)}
      </p>
    </section>
  );
}

/** The lead's estimate page (M3c spec §7.3) and the #customer layer (§7.2). */
export function EstimatePageClient({ jobId, estimateId }: { readonly jobId: string; readonly estimateId: string }) {
  const router = useRouter();
  const eid = estimateId.toLowerCase();
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error' | 'hidden'>('loading');
  const [recovering, setRecovering] = useState(true);
  /** Stored intents a reload left unanswered: the page stays locked until they are (M3b rule). */
  const [unresolved, setUnresolved] = useState(0);
  const [layer, setLayer] = useState<LayerState>(LAYER_CLOSED);
  const layerRef = useRef<LayerState>(LAYER_CLOSED);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [busy, setBusy] = useState<'sell' | 'bill' | 'decline' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [added, setAdded] = useState<{ readonly hasMaterials: boolean } | null>(null);
  const { phase: sellPhase, send: sellSend, settle: sellSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.sell(eid));
  /** A sale started in the open layer: it keeps its result screen even once the estimate is sold. */
  const saleStarted = useRef(false);
  /** The mount recovery, started once per estimate (StrictMode runs the mount effect twice). */
  const recovery = useRef<{ key: string; done: Promise<{ v: TechEstimatesView | null; unresolved: number }> } | null>(null);
  const { send: billSend, settle: billSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.bill(eid));
  const { send: declineSend, settle: declineSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.decline(eid));

  const refetch = useCallback(async (): Promise<TechEstimatesView | null> => {
    const r = await fetchEstimates(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setLoadState('ok');
      return r.view;
    }
    setLoadState((s) => (r.kind === 'hidden' ? 'hidden' : s === 'ok' ? s : 'error'));
    return null;
  }, [jobId, setView, setLoadState]); // setters listed: react-hooks/preserve-manual-memoization

  const dispatchLayer = useCallback((e: LayerEvent) => {
    const prev = layerRef.current;
    const step = layerStep(prev, e);
    layerRef.current = step.state;
    if (step.state.open !== prev.open) saleStarted.current = false;
    setLayer(step.state);
    runEffect(step.effect);
    if (prev.open && !step.state.open) void refetch(); // the layer closed: show the technician the real state
  }, [refetch, setLayer]);

  /** Re-send this estimate's stored intents (old body, old key); state only changes after the await. */
  const runRecovery = useCallback(async (): Promise<{ v: TechEstimatesView | null; unresolved: number }> => {
    const rec = await recoverEstimateIntents(jobId, (id) => id.endsWith(`:${eid}`));
    const v = await refetch();
    setUnresolved(rec.unresolved);
    setRecovering(false);
    return { v, unresolved: rec.unresolved };
  }, [jobId, eid, refetch, setUnresolved, setRecovering]);

  // Mount: recovery (a reload during Approving…) once, then load, then the #customer rule.
  // An unresolved stored intent keeps the layer shut: the page is locked until it is answered.
  useEffect(() => {
    let cancelled = false;
    const key = `${jobId}:${eid}`;
    if (recovery.current?.key !== key) recovery.current = { key, done: runRecovery() };
    const started = recovery.current.done;
    void (async () => {
      const { v, unresolved: left } = await started;
      if (cancelled) return;
      dispatchLayer({ type: 'mount', hash: window.location.hash, sellable: v !== null && left === 0 && canSell(v, findEstimate(v, eid)) });
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, eid, runRecovery, dispatchLayer]);

  useEffect(() => {
    const onPop = () => dispatchLayer({ type: 'popstate', hash: window.location.hash });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [dispatchLayer]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  const approve = useCallback(async (optionId: string, signatureName: string, onChecking: () => void): Promise<'success' | 'failed'> => {
    saleStarted.current = true;
    setNote(null);
    const r = await sellSend(`/api/tech/jobs/${jobId}/estimates/${eid}/sell`, { optionId, signatureName });
    const first = approveFirst(r);
    if (first === 'success' && r.sent) {
      // Settle only after the refetch: the sell stays 'sent' (page locked) until the page shows the sale,
      // even when Back closed the layer during Approving… (final review B P1-1).
      void refetch().finally(() => sellSettle(r.outcome, false));
      return 'success';
    }
    if (first === 'check') {
      // Nothing sent (a sell is still in flight), an older stored sell re-sent, or an unknown answer:
      // only the refetched estimate decides, never a blind success (review spec m10, fix round 1).
      onChecking();
      if (r.sent && r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      if (r.sent) sellSettle(r.outcome, sellAdvanced(e));
      if (afterCheck(e, optionId)) return 'success';
      setNote(saleFailNote(r));
      return 'failed';
    }
    if (r.sent) sellSettle(r.outcome, false);
    await refetch();
    setNote(saleFailNote(r));
    return 'failed';
  }, [jobId, eid, sellSend, sellSettle, refetch, setNote]);

  /** Try again on an unknown sell: re-send the stored sell (old body, old key), then refetch. */
  async function retrySell(): Promise<void> {
    setBusy('sell');
    setNote(null);
    const r = await sellSend(`/api/tech/jobs/${jobId}/estimates/${eid}/sell`, {});
    if (r.sent) {
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      sellSettle(r.outcome, sellAdvanced(e));
      if (!sellAdvanced(e)) setNote(saleFailNote(r));
    }
    setBusy(null);
  }

  // A refetch that removed the estimate or made it unsellable closes an open layer (one Back pops its #customer entry).
  useEffect(() => {
    const sellable = loadState === 'ok' && view !== null && canSell(view, findEstimate(view, eid));
    if (layerStale({ open: layer.open, saleStarted: saleStarted.current, sellable })) dispatchLayer({ type: 'close' });
  }, [layer.open, loadState, view, eid, dispatchLayer]);

  async function addToInvoice(): Promise<void> {
    setBusy('bill');
    setNote(null);
    setAdded(null);
    const r = await billSend(`/api/tech/jobs/${jobId}/estimates/${eid}/bill`, {});
    if (!r.sent) {
      setBusy(null);
      return;
    }
    const code = r.envelope?.error?.code ?? null;
    if (r.outcome === 'success_refetch' || r.outcome === 'already_saved_refetch') {
      billSettle(r.outcome, false);
      setAdded({ hasMaterials: (r.envelope?.data as { hasMaterials?: boolean } | undefined)?.hasMaterials === true });
      await refetch();
    } else if (code === 'ALREADY_BILLED') {
      // Rendered as the billed state after the refetch, never as an error (spec §5.3 step 4).
      billSettle(r.outcome, false);
      await refetch();
    } else if (r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch') {
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      const landed = e !== null && e.billing !== 'none';
      billSettle(r.outcome, landed);
      if (!landed) setNote(estimateWriteCopy(r.outcome, r.envelope));
    } else {
      billSettle(r.outcome, false);
      await refetch();
      setNote(estimateWriteCopy(r.outcome, r.envelope));
    }
    setBusy(null);
  }

  async function markDeclined(): Promise<void> {
    setBusy('decline');
    setNote(null);
    const r = await declineSend(`/api/tech/jobs/${jobId}/estimates/${eid}/decline`, {});
    if (!r.sent) {
      setBusy(null);
      return;
    }
    if (r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch') {
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      const landed = e?.status === 'declined';
      declineSettle(r.outcome, landed);
      if (!landed) setNote(estimateWriteCopy(r.outcome, r.envelope));
    } else {
      declineSettle(r.outcome, false);
      await refetch();
      if (r.outcome !== 'success_refetch' && r.outcome !== 'already_saved_refetch') setNote(estimateWriteCopy(r.outcome, r.envelope));
    }
    setConfirmDecline(false);
    setBusy(null);
  }

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to the job
    </Link>
  );
  const e = findEstimate(view, eid);

  if (loadState === 'loading') return <div className="space-y-4">{back}<Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (loadState !== 'ok' || !view) {
    return <div className="space-y-4">{back}<p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this estimate. Go back and try again.</p></div>;
  }
  if (!view.isLead) return <div className="space-y-4">{back}<p className="text-[15px]">Only the lead technician can open this.</p></div>;
  if (!e) return <div className="space-y-4">{back}<p className="text-[15px]">That estimate isn&apos;t on this job.</p></div>;

  const sellUnknown = sellPhase === 'unknown';
  const locked = pageLocked({ recovering, unresolved, sellPhase, busy });
  const sellable = canSell(view, e);
  const sold = e.status === 'sold' ? soldOptionOf(e) : null;
  const billingView = e.status === 'sold' ? soldBillingView(e, view) : null;

  return (
    <div className="space-y-4 pb-6">
      {back}
      {(unresolved > 0 || sellUnknown) && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
          <span>{MAY_NOT_HAVE_SAVED}</span>
          <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={recovering || busy !== null}
            onClick={() => {
              if (unresolved > 0) {
                setRecovering(true);
                void runRecovery();
              } else void retrySell();
            }}>
            Try again
          </Button>
        </div>
      )}
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-[17px]">{e.label}</CardTitle>
          <p className="text-[13px] font-medium text-muted-foreground">{STATUS_CHIP[e.status]}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {e.status === 'sold' && sold ? (
            <>
              <p className="text-[15px] font-medium">{approvedLine(e.signedAt, sold.name)}</p>
              <OptionBlock o={sold} />
              {billingView?.kind === 'add' && (
                <div className="space-y-2">
                  {billingView.newInvoice && <p className="text-[15px] text-muted-foreground">{SOLD_COPY.newInvoice}</p>}
                  <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void addToInvoice()}>
                    {busy === 'bill' ? SOLD_ACTIONS.adding : SOLD_ACTIONS.add}
                  </Button>
                  {billingView.leave && (
                    <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => router.push(`/tech/jobs/${jobId}`)}>
                      {SOLD_ACTIONS.leave}
                    </Button>
                  )}
                </div>
              )}
              {billingView?.kind === 'locked' && <p className="text-[15px]">{SOLD_COPY.locked}</p>}
              {billingView?.kind === 'office' && <p className="text-[15px]">{BILLING_LINE.office}</p>}
              {billingView?.kind === 'closed' && <p className="text-[15px] text-muted-foreground">{BILLING_LINE.none}</p>}
              {billingView?.kind === 'job' && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[15px]">{BILLING_LINE.job}</p>
                  <Link href={`/tech/jobs/${jobId}/invoice`} className="inline-flex h-11 items-center rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium active:bg-accent">
                    {SOLD_ACTIONS.openInvoice}
                  </Link>
                </div>
              )}
              {added && (
                <div role="status" className="space-y-1 rounded-md border border-success-border bg-success-light px-3 py-2 text-[15px]">
                  <p>{SOLD_COPY.added}</p>
                  {added.hasMaterials && <p>{SOLD_COPY.overlap}</p>}
                </div>
              )}
            </>
          ) : (
            <>
              {e.options.map((o) => <OptionBlock key={o.id} o={o} />)}
              {e.status === 'open' && e.hasApprovalLink && <p className="text-[13px] text-muted-foreground">{SOLD_COPY.approvalLink}</p>}
              {sellable && !confirmDecline && (
                <div className="space-y-2">
                  <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => dispatchLayer({ type: 'show' })}>
                    {SOLD_ACTIONS.show}
                  </Button>
                  <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDecline(true)}>
                    {DECLINE_COPY.button}
                  </Button>
                </div>
              )}
              {sellable && confirmDecline && (
                <div className="space-y-2 rounded-xl border border-border p-3">
                  <p className="text-[15px]">{DECLINE_COPY.confirm}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" className="h-11 flex-1 rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDecline(false)}>{DECLINE_COPY.no}</Button>
                    <Button variant="destructive" className="h-11 flex-1 rounded-xl text-[15px]" disabled={locked} onClick={() => void markDeclined()}>{DECLINE_COPY.yes}</Button>
                  </div>
                </div>
              )}
            </>
          )}
          {techNoteVisible({ note, layerOpen: layer.open, banner: unresolved > 0 || sellUnknown }) && <p role="alert" className="text-[15px] text-danger-strong">{note}</p>}
        </CardContent>
      </Card>

      {layer.open && (
        <CustomerView
          estimate={e}
          companyName={view.companyName}
          customerDisplayName={view.customerDisplayName}
          taxBps={view.taxBps}
          onApprove={approve}
          onClose={() => dispatchLayer({ type: 'close' })}
        />
      )}
    </div>
  );
}
