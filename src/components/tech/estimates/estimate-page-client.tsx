'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { CUSTOMER_HASH, LAYER_CLOSED, layerStep, type LayerEffect, type LayerEvent, type LayerState } from '@/lib/tech/customer-view-state';
import { DECLINE_COPY, SOLD_ACTIONS, afterCheck, approvedLine, saleResult } from '@/lib/tech/estimate-page-copy';
import { BILLING_LINE, SOLD_COPY, STATUS_CHIP, canSell, soldBillingView, soldOptionOf } from '@/lib/tech/estimate-display';
import { ESTIMATE_INTENT, estimateWriteCopy } from '@/lib/tech/estimate-intents';
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
  const [busy, setBusy] = useState<'bill' | 'decline' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [added, setAdded] = useState<{ readonly hasMaterials: boolean } | null>(null);
  const { send: sellSend, settle: sellSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.sell(eid));
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
    setLayer(step.state);
    runEffect(step.effect);
    if (prev.open && !step.state.open) void refetch(); // the layer closed: show the technician the real state
  }, [refetch, setLayer]);

  /** Re-send this estimate's stored intents (old body, old key); state only changes after the await. */
  const runRecovery = useCallback(async (): Promise<TechEstimatesView | null> => {
    const rec = await recoverEstimateIntents(jobId, (id) => id.endsWith(`:${eid}`));
    const v = await refetch();
    setUnresolved(rec.unresolved);
    setRecovering(false);
    return v;
  }, [jobId, eid, refetch, setUnresolved, setRecovering]);

  // Mount: recovery (a reload during Approving…), then load, then the #customer rule.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const v = await runRecovery();
      if (cancelled) return;
      dispatchLayer({ type: 'mount', hash: window.location.hash, sellable: v !== null && canSell(v, findEstimate(v, eid)) });
    })();
    return () => {
      cancelled = true;
    };
  }, [eid, runRecovery, dispatchLayer]);

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
    const r = await sellSend(`/api/tech/jobs/${jobId}/estimates/${eid}/sell`, { optionId, signatureName });
    if (!r.sent) {
      // A sell for this estimate is still in flight: let the refetch decide, never a premature failure (review spec m10).
      onChecking();
      return afterCheck(findEstimate(await refetch(), eid), optionId) ? 'success' : 'failed';
    }
    const first = saleResult(r.outcome);
    if (first === 'success') {
      sellSettle(r.outcome, false);
      return 'success';
    }
    if (first === 'check') {
      onChecking();
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const ok = afterCheck(findEstimate(await refetch(), eid), optionId);
      sellSettle(r.outcome, ok);
      return ok ? 'success' : 'failed';
    }
    sellSettle(r.outcome, false);
    return 'failed';
  }, [jobId, eid, sellSend, sellSettle, refetch]);

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
    if (r.outcome === 'success_refetch') {
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
      if (r.outcome !== 'success_refetch') setNote(estimateWriteCopy(r.outcome, r.envelope));
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

  const locked = recovering || unresolved > 0 || busy !== null;
  const sellable = canSell(view, e);
  const sold = e.status === 'sold' ? soldOptionOf(e) : null;
  const billingView = e.status === 'sold' ? soldBillingView(e, view) : null;

  return (
    <div className="space-y-4 pb-6">
      {back}
      {unresolved > 0 && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
          <span>Your last tap may not have saved. Try again.</span>
          <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={recovering}
            onClick={() => { setRecovering(true); void runRecovery(); }}>
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
                  <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => router.push(`/tech/jobs/${jobId}`)}>
                    {SOLD_ACTIONS.leave}
                  </Button>
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
          {note && <p role="alert" className="text-[15px] text-danger-strong">{note}</p>}
        </CardContent>
      </Card>

      {layer.open && (
        <CustomerView
          estimate={e}
          companyName={view.companyName}
          customerDisplayName={view.customerDisplayName}
          onApprove={approve}
          onClose={() => dispatchLayer({ type: 'close' })}
        />
      )}
    </div>
  );
}
