'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { unknownBanner } from '@/lib/tech/approval-flow';
import { invoiceChipLabel, materialsPrompt } from '@/lib/tech/invoice-page-copy';
import { fullInvoice } from '@/lib/tech/invoice-view-diff';
import type { TechInvoiceView } from '@/lib/tech/invoice-view';
import { AddItemSheet, type PricebookHit } from './add-item-sheet';
import { devCollectSheet, InvoiceCollectButtons, type CollectSheet } from './invoice-collect-buttons';
import { InvoiceLines, InvoiceTotals, UnbilledMaterials } from './invoice-lines';
import { InvoicePayments, InvoiceSignature } from './invoice-record';
import { deleteJson, postJson } from './post-json';
import { useInvoiceWrites, type InvoicePageApi, type WriteResult } from './use-invoice-writes';

type Load = 'loading' | 'ok' | 'not_found' | 'external' | 'error';
interface Header { readonly customerName: string | null; readonly referenceNumber: string | null }

const PAGE = 'space-y-4';
const NOTE = 'rounded-md border border-border bg-surface-raised px-3 py-2.5 text-[15px] text-muted-foreground';
const PENDING_POLL_MS = 3000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * S40 — the technician's field invoice (spec §7). GETs on mount, after every
 * write and on `visibilitychange`; every write goes through `write()` (key
 * reducer → send → classify → refetch → landed?). The approval, record payment
 * and pay link sheets mount through `InvoiceCollectButtons` with the `InvoicePageApi`.
 */
export function InvoicePageClient({ id, devOpenAddItem = false }: { readonly id: string; readonly devOpenAddItem?: boolean }) {
  const base = `/api/tech/jobs/${id}/invoice`;
  const [view, setView] = useState<TechInvoiceView | null>(null);
  const viewRef = useRef<TechInvoiceView | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [refreshError, setRefreshError] = useState(false);
  const [header, setHeader] = useState<Header>({ customerName: null, referenceNumber: null });
  const [materialCount, setMaterialCount] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [addOpen, setAddOpen] = useState(devOpenAddItem);
  const [collectSheet, setCollectSheet] = useState<CollectSheet | null>(devCollectSheet);
  // The payment-success line; separate from `message` so opening a sheet never clears an error.
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<TechInvoiceView | null> => {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        viewRef.current = body.data as TechInvoiceView;
        setView(viewRef.current);
        setLoad('ok');
        setRefreshError(false);
        return viewRef.current;
      }
      if (res.status === 404) setLoad('not_found');
      else if (res.status === 409) setLoad('external');
      else if (!viewRef.current) setLoad('error');
      else setRefreshError(true);
    } catch {
      if (!viewRef.current) setLoad('error');
      else setRefreshError(true);
    }
    return null;
  }, [base]);

  const { write, retry, busy, recovering, unknownKinds, inFlight } = useInvoiceWrites({ jobId: id, viewRef, refetch });

  useEffect(() => {
    void refetch();
    void (async () => {
      try {
        const [summary, materials] = await Promise.all([
          fetch(`/api/tech/jobs/${id}`).then((r) => r.json()),
          fetch(`/api/tech/jobs/${id}/materials`).then((r) => r.json()),
        ]);
        if (summary?.success) setHeader({ customerName: summary.data.customerName, referenceNumber: summary.data.referenceNumber });
        if (materials?.success) setMaterialCount(materials.data.materials.length);
      } catch {
        /* the header falls back to the job id */
      }
    })();
  }, [id, refetch]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  // Another tap is still saving on the server: look again until it settles.
  useEffect(() => {
    if (!view?.pendingWrite) return;
    const t = setTimeout(() => void refetch(), PENDING_POLL_MS);
    return () => clearTimeout(t);
  }, [view, refetch]);

  const report = useCallback((r: WriteResult): WriteResult => {
    // `pending` (the server still holds the tap) and `skipped` read as status, not as an error.
    setMessage(
      r.status === 'done' || r.status === 'dropped' || !r.message
        ? null
        : { text: r.message, error: r.status !== 'pending' && r.status !== 'skipped' },
    );
    return r;
  }, []);

  if (load === 'loading') {
    return (
      <div className={PAGE}>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const back = (
    <Link href={`/tech/jobs/${id}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to job
    </Link>
  );
  if (load !== 'ok' || !view) {
    const text =
      load === 'not_found' ? "This job isn't yours." : load === 'external' ? 'Invoice in FieldPulse.' : "Couldn't load the invoice.";
    return (
      <div className={PAGE}>
        {back}
        <p className={NOTE} role={load === 'error' ? 'alert' : undefined}>{text}</p>
      </div>
    );
  }

  const inv = view.invoice;
  const full = fullInvoice(view);
  const locked = view.pendingWrite || recovering || busy !== null || unknownKinds.length > 0;
  // The add-item sheet re-sends its own unknown add ("Try again"); only OTHER unknown intents lock it.
  const addLocked =
    view.pendingWrite || recovering || (busy !== null && busy !== 'add_line') || unknownKinds.some((k) => k !== 'add_line');
  const banner = unknownBanner(unknownKinds);
  const can = (a: TechInvoiceView['allowed'][number]) => view.allowed.includes(a);
  const api: InvoicePageApi = { view, refetch, write };

  const create = () =>
    void write({ kind: 'create' }, (key) => postJson(base, {}, key), {}).then(report);
  const addMaterial = (jobMaterialId: string) => {
    if (!full) return;
    const body = { invoiceId: full.id, jobMaterialId };
    void write({ kind: 'add_line', jobMaterialId }, (key) => postJson(`${base}/lines`, body, key), body).then(report);
  };
  const addItem = (item: PricebookHit, quantity: number): Promise<WriteResult> => {
    if (!full) return Promise.resolve({ status: 'skipped', message: null });
    const body = { invoiceId: full.id, pricebookItemId: item.id, quantity };
    const intent = { kind: 'add_line', pricebookItemId: item.id, name: item.name, unitPriceCents: item.priceCents, quantity } as const;
    return write(intent, (key) => postJson(`${base}/lines`, body, key), body);
  };
  const remove = (lineId: string) => {
    if (!full) return;
    const body = { invoiceId: full.id, lineId };
    const path = `${base}/lines/${lineId}?invoiceId=${encodeURIComponent(full.id)}`;
    void write({ kind: 'remove_line', lineId }, () => deleteJson(path), body).then(report);
  };

  const otherDue = view.otherOpen.reduce((s, o) => s + o.balanceCents, 0);

  return (
    <div className={PAGE}>
      {back}
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h1 className="min-w-0 text-[20px] leading-7 font-semibold break-words">
            {header.customerName ?? `Job ${id.slice(0, 8)}`}
          </h1>
          <span className="shrink-0 rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
            {invoiceChipLabel(inv)}
          </span>
        </div>
        {header.referenceNumber && (
          <p className="font-mono text-[13px] tabular-nums text-muted-foreground">{header.referenceNumber}</p>
        )}
        {view.history && (
          <p className="text-[13px] text-muted-foreground">
            Previous invoice: {cap(view.history.state)} {formatCentsExact(view.history.totalCents)}
          </p>
        )}
        {view.otherOpen.length > 0 && (
          <p className="text-[13px] text-muted-foreground">
            {view.otherOpen.length} other open {view.otherOpen.length === 1 ? 'invoice' : 'invoices'} on this job ·{' '}
            {formatCentsExact(otherDue)} due
          </p>
        )}
      </header>

      {(view.pendingWrite || recovering) && <p role="status" className={NOTE}>Still saving your last tap…</p>}
      {banner && busy === null && !recovering && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
          <span>{banner.text}</span>
          <Button
            variant="outline"
            className="h-11 shrink-0 rounded-xl px-4"
            disabled={view.pendingWrite}
            onClick={() => (banner.action === 'open_approval' ? setCollectSheet('approval') : void retry(banner.kind).then(report))}
          >
            Try again
          </Button>
        </div>
      )}
      {notice && <p role="status" className="text-[15px] text-success-strong">{notice}</p>}
      {message && (
        <p role={message.error ? 'alert' : 'status'} className={`text-[15px] ${message.error ? 'text-danger-strong' : 'text-muted-foreground'}`}>
          {message.text}
        </p>
      )}
      {refreshError && (
        <div role="alert" className="flex items-center justify-between gap-3 text-[15px] text-danger-strong">
          <span>Couldn&apos;t refresh the invoice.</span>
          <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {view.externalInvoice ? (
        <p className={NOTE}>Invoice in FieldPulse.</p>
      ) : !view.isLead ? (
        <Card>
          <CardContent className="space-y-2">
            {inv && (
              <div className="flex items-baseline justify-between text-[15px]">
                <span className="text-muted-foreground">Total</span>
                <span className="font-mono tabular-nums">{formatCentsExact(inv.totalCents)}</span>
              </div>
            )}
            <p className="text-[15px] text-muted-foreground">The lead technician handles the invoice.</p>
          </CardContent>
        </Card>
      ) : !full ? (
        <Card>
          <CardContent className="space-y-3">
            <p className="text-[15px]">{materialCount === null ? 'Start from the materials on this job.' : materialsPrompt(materialCount)}</p>
            {can('create') ? (
              <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked || inFlight('create')} onClick={create}>
                {busy === 'create' ? 'Creating…' : 'Create invoice'}
              </Button>
            ) : (
              !view.onSite && <p className={NOTE}>Arrive at the job before invoicing.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <InvoiceLines invoice={full} onRemove={can('remove_line') ? remove : undefined} disabled={locked} />
            {full.state === 'draft' && can('add_line') && (
              <>
                <Button variant="outline" className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => setAddOpen(true)}>
                  Add item
                </Button>
                <UnbilledMaterials materials={view.materialsNotOnInvoice} onAdd={addMaterial} disabled={locked} />
              </>
            )}
            <InvoiceTotals invoice={full} />
            {full.state !== 'draft' && (
              <>
                <InvoiceSignature signature={full.signature} onImageError={() => void refetch()} />
                <InvoicePayments payments={full.payments} />
              </>
            )}
            <InvoiceCollectButtons api={api} invoice={full} jobId={id} unknownKinds={unknownKinds}
              sheet={collectSheet}
              onSheet={setCollectSheet}
              onNotice={setNotice}
            />
          </CardContent>
        </Card>
      )}

      <AddItemSheet open={addOpen && !!full} onClose={() => setAddOpen(false)} onAdd={addItem} onRetry={() => retry('add_line')} disabled={addLocked} />
    </div>
  );
}
