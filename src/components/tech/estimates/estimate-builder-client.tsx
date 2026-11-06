'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { mintKey } from '@/lib/http/idempotency-codes';
import { AddItemSheet, type PricebookHit } from '@/components/tech/invoice/add-item-sheet';
import type { WriteResult } from '@/components/tech/invoice/use-invoice-writes';
import {
  DRAFT_KEY, EARLIER_SAVE_WON, addLine, afterSave, checkDraft, nextOptionNames, optionFooter, parseDraft, removeLine, serializeDraft, setQuantity, startOptions,
  type DraftOption,
} from '@/lib/tech/estimate-builder';
import { MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY } from '@/lib/tech/estimate-input';
import { ESTIMATE_INTENT, MAY_NOT_HAVE_SAVED, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import type { TechEstimatesView } from '@/lib/tech/estimate-view';
import { fetchEstimates } from './fetch-estimates';
import { recoverEstimateIntents } from './recover-intents';
import { useEstimateWrite } from './use-estimate-write';

const UNDO_MS = 5000;

type Undo = { readonly label: string; readonly snapshot: readonly DraftOption[] };

function clearDraft(jobId: string): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY(jobId));
  } catch {
    /* storage unavailable */
  }
}

/** The lead builds up to three options from the pricebook (M3c spec §7.1). */
export function EstimateBuilderClient({ jobId }: { readonly jobId: string }) {
  const router = useRouter();
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [options, setOptions] = useState<readonly DraftOption[]>(() => startOptions(mintKey()));
  const [restored, setRestored] = useState(false);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(true);
  /** retry: 'recover' = a reload left the last save unanswered (re-send it); 'save' = this save's answer is unknown. */
  const [message, setMessage] = useState<{ readonly text: string; readonly retry: 'recover' | 'save' | null } | null>(null);
  const create = useEstimateWrite(jobId, ESTIMATE_INTENT.create);
  /** An earlier, unanswered save was re-sent and landed: the newer edits were not saved (Task 8 parked). */
  const [earlierWon, setEarlierWon] = useState<{ readonly estimateId: unknown } | null>(null);
  /** The mount recovery, started once per job (StrictMode runs the mount effect twice). */
  const recovery = useRef<{ jobId: string; done: Promise<void> } | null>(null);

  const openSaved = useCallback((estimateId: unknown) => {
    clearDraft(jobId);
    router.push(typeof estimateId === 'string' ? `/tech/jobs/${jobId}/estimates/${estimateId}` : `/tech/jobs/${jobId}`);
  }, [jobId, router]);

  // Restore the draft once on mount, then keep it in sessionStorage.
  useEffect(() => {
    try {
      const draft = parseDraft(window.sessionStorage.getItem(DRAFT_KEY(jobId)));
      if (draft) setOptions(draft);
    } catch {
      /* storage unavailable */
    }
    setRestored(true);
  }, [jobId]);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY(jobId), serializeDraft(options));
    } catch {
      /* storage unavailable */
    }
  }, [jobId, options, restored]);

  const recover = useCallback(async () => {
    setRecovering(true);
    const rec = await recoverEstimateIntents(jobId, (id) => id === ESTIMATE_INTENT.create);
    const saved = rec.succeeded.find((s) => s.intentId === ESTIMATE_INTENT.create);
    if (saved) {
      openSaved(saved.data.estimateId);
      return;
    }
    setMessage(rec.unresolved > 0 ? { text: MAY_NOT_HAVE_SAVED, retry: 'recover' } : null);
    setRecovering(false);
  }, [jobId, openSaved]);

  useEffect(() => {
    let cancelled = false;
    if (recovery.current?.jobId !== jobId) recovery.current = { jobId, done: recover() };
    const started = recovery.current.done;
    void (async () => {
      await started;
      const r = await fetchEstimates(jobId);
      if (cancelled) return;
      if (r.kind === 'ok') {
        setView(r.view);
        setLoadState('ok');
      } else {
        setLoadState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, recover]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const onAdd = useCallback(async (item: PricebookHit, quantity: number): Promise<WriteResult> => {
    if (!sheetFor) return { status: 'skipped', message: null };
    setOptions((prev) => addLine(prev, sheetFor, {
      key: mintKey(), pricebookItemId: item.id, name: item.name, unitPriceCents: item.priceCents, quantity,
    }));
    return { status: 'done', message: null };
  }, [sheetFor]);

  async function save(): Promise<void> {
    const check = checkDraft(options);
    // While the last save is unknown, send re-sends the stored body whatever the draft says.
    if ((!check.ok && create.phase !== 'unknown') || saving || recovering) return;
    setSaving(true);
    setMessage(null);
    const r = await create.send(`/api/tech/jobs/${jobId}/estimates`, check.ok ? check.body : {});
    if (!r.sent) {
      setSaving(false);
      return;
    }
    create.settle(r.outcome, false);
    const landed = afterSave(r.outcome, r.resentOld);
    const estimateId = r.outcome === 'success_refetch' ? (r.envelope?.data as { estimateId?: unknown } | undefined)?.estimateId : null;
    if (landed === 'open') {
      openSaved(estimateId);
      return;
    }
    if (landed === 'earlier_won') {
      setSaving(false);
      setEarlierWon({ estimateId });
      return;
    }
    setSaving(false);
    setMessage({
      text: estimateWriteCopy(r.outcome, r.envelope),
      retry: r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch' ? 'save' : null,
    });
  }

  function removeOption(o: DraftOption): void {
    setUndo({ label: `Removed ${o.name.trim() || 'the option'}.`, snapshot: options });
    setOptions((prev) => nextOptionNames(prev, { type: 'remove', key: o.key }));
  }

  function removeItem(optionKey: string, lineKey: string, name: string): void {
    setUndo({ label: `Removed ${name}.`, snapshot: options });
    setOptions((prev) => removeLine(prev, optionKey, lineKey));
  }

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to the job
    </Link>
  );

  if (loadState === 'loading' || !restored) {
    return <div className="space-y-4">{back}<Skeleton className="h-40 w-full rounded-xl" /></div>;
  }
  if (loadState === 'error' || !view) {
    return <div className="space-y-4">{back}<p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this job. Go back and try again.</p></div>;
  }
  if (!view.isLead) {
    return <div className="space-y-4">{back}<p className="text-[15px]">Only the lead technician can open this.</p></div>;
  }

  const check = checkDraft(options);
  const taxBps = view.taxBps;
  const locked = saving || recovering || earlierWon !== null;

  return (
    <div className="space-y-4 pb-6">
      {back}
      <h2 className="text-[20px] font-semibold tracking-tight">New estimate</h2>
      {view.hasOtherSold && <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">This job already has a sold estimate.</p>}
      {!view.canCreate && view.createBlockedReason && <p className="text-[15px] text-muted-foreground">{view.createBlockedReason}</p>}

      {options.map((o, i) => (
        <Card key={o.key}>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Input
              aria-label={`Option ${i + 1} name`}
              value={o.name}
              maxLength={MAX_OPTION_NAME}
              disabled={locked}
              onChange={(e) => setOptions((prev) => nextOptionNames(prev, { type: 'rename', key: o.key, name: e.target.value }))}
              className="h-11 flex-1 rounded-xl text-[16px] font-medium"
            />
            {options.length >= 2 && (
              <Button variant="ghost" className="h-11 rounded-xl px-3 text-[15px]" disabled={locked} onClick={() => removeOption(o)}>
                Remove option
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {o.lines.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No items yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label={`${o.name} items`}>
                {o.lines.map((l) => (
                  <li key={l.key} className="flex min-h-14 flex-wrap items-center gap-2 py-2">
                    {/* Own line at 390 px: the stepper, total and remove leave the name no room beside them. */}
                    <span className="min-w-0 basis-full text-[15px] break-words">{l.name}</span>
                    <Button variant="outline" className="size-11 rounded-xl" aria-label={`Fewer ${l.name}`} disabled={locked || l.quantity <= 1}
                      onClick={() => setOptions((prev) => setQuantity(prev, o.key, l.key, l.quantity - 1))}>
                      <Minus className="size-4" />
                    </Button>
                    <span className="w-8 text-center font-mono text-[15px] tabular-nums" aria-label="Quantity">{l.quantity}</span>
                    <Button variant="outline" className="size-11 rounded-xl" aria-label={`More ${l.name}`} disabled={locked || l.quantity >= MAX_QUANTITY}
                      onClick={() => setOptions((prev) => setQuantity(prev, o.key, l.key, l.quantity + 1))}>
                      <Plus className="size-4" />
                    </Button>
                    <span className="ml-auto w-24 text-right font-mono text-[15px] tabular-nums">{formatCentsExact(l.unitPriceCents * l.quantity)}</span>
                    <Button variant="ghost" className="size-11 rounded-xl text-muted-foreground" aria-label={`Remove ${l.name}`} disabled={locked}
                      onClick={() => removeItem(o.key, l.key, l.name)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={locked} onClick={() => setSheetFor(o.key)}>
              <Plus className="mr-1 size-4" /> Add item
            </Button>
            <p className="font-mono text-[13px] tabular-nums text-muted-foreground">{optionFooter(o.lines, taxBps)}</p>
          </CardContent>
        </Card>
      ))}

      {options.length < MAX_OPTIONS && (
        <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked}
          onClick={() => setOptions((prev) => nextOptionNames(prev, { type: 'add', key: mintKey() }))}>
          Add option
        </Button>
      )}

      {undo && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3 py-2 text-[15px]">
          <span>{undo.label}</span>
          <Button variant="ghost" className="h-11 rounded-xl px-3 text-[15px]" onClick={() => { setOptions(undo.snapshot); setUndo(null); }}>Undo</Button>
        </div>
      )}

      {!check.ok && <p className="text-[15px] text-muted-foreground">{check.reason}</p>}
      {message && <p role="alert" className="text-[15px] text-danger-strong">{message.text}</p>}
      {earlierWon ? (
        <div className="space-y-2">
          <p role="alert" className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">{EARLIER_SAVE_WON}</p>
          <Button className="h-12 w-full rounded-xl text-[16px]" onClick={() => openSaved(earlierWon.estimateId)}>Open the estimate</Button>
        </div>
      ) : (
        <Button className="h-12 w-full rounded-xl text-[16px]"
          // A retry re-sends the OLD body, so it stays tappable even while the edited draft is invalid (review spec m8).
          disabled={locked || (!message?.retry && (!check.ok || !view.canCreate))}
          onClick={() => void (message?.retry === 'recover' ? recover() : save())}>
          {saving || recovering ? 'Saving…' : message?.retry ? 'Try again' : 'Save estimate'}
        </Button>
      )}

      {confirmDiscard ? (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-[15px]">Discard this draft?</p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl text-[15px]" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="destructive" className="h-11 flex-1 rounded-xl text-[15px]"
              onClick={() => { clearDraft(jobId); setOptions(startOptions(mintKey())); setUndo(null); setConfirmDiscard(false); }}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDiscard(true)}>
          Discard draft
        </Button>
      )}

      <AddItemSheet open={sheetFor !== null} onClose={() => setSheetFor(null)} onAdd={onAdd} disabled={locked} />
    </div>
  );
}
