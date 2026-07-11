'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Receipt } from 'lucide-react';
import { useInvoices, type InvoiceSortKey } from '@/hooks/use-invoices';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { TableSkeleton, StatTileSkeleton } from '@/components/admin/skeletons';
import { SummaryBand } from '@/components/admin/invoices/summary-band';
import { InvoiceRow } from '@/components/admin/invoices/invoice-row';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import { invoiceRef } from '@/lib/admin/invoice-collectible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ── constants ─────────────────────────────────────────────────────────────────

const PER_PAGE = 50;

const REASON_MAP: Record<string, string> = {
  COOLDOWN: 'A reminder was already sent recently.',
  NO_CONTACT: 'No phone or email on file for this customer.',
  NO_TEMPLATE: 'No reminder template is configured.',
  NOT_COLLECTIBLE: "This invoice isn't collectible.",
  NOT_FOUND: 'Invoice not found.',
};

const VOID_FAIL: Record<string, string> = {
  synced_read_only: "Synced invoices can't be voided here.",
  has_payments: "This invoice has payments — refund it first.",
  not_voidable: "This invoice can't be voided.",
  not_found: 'Invoice not found.',
};

// ── filter types ─────────────────────────────────────────────────────────────

type Filter = 'overdue' | 'all' | 'unpaid' | 'paid';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
];

// Map UI filter tabs to server-side `state` param values.
// 'overdue' and 'unpaid' both filter to state='open' on the server;
// the overdue distinction uses the client-side sortKey to push overdue first.
function filterToState(filter: Filter): string | undefined {
  if (filter === 'paid') return 'paid';
  if (filter === 'unpaid' || filter === 'overdue') return 'open';
  return undefined; // 'all' — no state filter
}

// ── source types ──────────────────────────────────────────────────────────────

type SourceValue = 'all' | 'native' | 'fieldpulse' | 'housecall';
type SourceOption = { value: SourceValue; label: string };

// ── sort options ──────────────────────────────────────────────────────────────

const SORT_OPTIONS: ReadonlyArray<{ value: InvoiceSortKey; label: string }> = [
  { value: 'age-oldest', label: 'Age oldest-first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'balance-high', label: 'Balance high→low' },
];

// ── ReconcileBanner (unchanged) ───────────────────────────────────────────────

interface StuckPayment {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
}

function ReconcileBanner() {
  const [stuck, setStuck] = useState<readonly StuckPayment[]>([]);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/payments/reconcile');
      if (!res.ok) return;
      const body = (await res.json()) as {
        success: boolean;
        data: { stuck: StuckPayment[] };
      };
      if (body.success) setStuck(body.data.stuck);
    } catch {
      // banner is best-effort; silent on failure
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reconcile = useCallback(async () => {
    setRunning(true);
    try {
      await fetch('/api/admin/payments/reconcile', { method: 'POST' });
      await load();
    } finally {
      setRunning(false);
    }
  }, [load]);

  if (stuck.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {stuck.length} payment{stuck.length === 1 ? '' : 's'} stuck in a pending
          state may need reconciliation.
        </span>
        <Button size="sm" variant="outline" onClick={reconcile} disabled={running}>
          {running ? 'Reconciling…' : 'Reconcile now'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const [filter, setFilter] = useState<Filter>('overdue');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortKey, setSortKey] = useState<InvoiceSortKey>('age-oldest');
  const [source, setSource] = useState<SourceValue>('all');
  const [page, setPage] = useState(1);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive server params from UI state
  const serverState = filterToState(filter);
  const serverOverdue = filter === 'overdue';
  const serverSource = source === 'all' ? undefined : source;

  const { invoices, total, sourceCounts, stats, collectedThisMonthCents, isLoading, error, sendReminder, voidInvoice } = useInvoices({
    page,
    limit: PER_PAGE,
    search: debouncedSearch || undefined,
    state: serverState,
    overdue: serverOverdue,
    source: serverSource,
    sort: sortKey,
  });

  // auto-clear flash after 3s
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // 300ms debounce on search — also resets page
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page when filter/source change
  useEffect(() => { setPage(1); }, [filter, source]);

  const showFlash = useCallback((msg: string, ok: boolean) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlash({ msg, ok });
    flashTimerRef.current = setTimeout(() => setFlash(null), 3000);
  }, []);

  const handleRemind = useCallback(async (id: string) => {
    if (pendingId === id) return;
    setPendingId(id);
    try {
      const inv = invoices.find((i) => i.id === id);
      const name = inv?.customerName ?? 'customer';
      const result = await sendReminder(id);
      if (result.ok) {
        showFlash(`Reminder sent to ${name}`, true);
      } else {
        const key = (result.reason ?? '').toUpperCase();
        showFlash(REASON_MAP[key] ?? 'Could not send reminder.', false);
      }
    } finally {
      setPendingId(null);
    }
  }, [invoices, pendingId, sendReminder, showFlash]);

  const handleCopyPayLink = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/invoices/${id}/pay-link`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { payLink?: string };
      };
      if (res.ok && body.success && body.data?.payLink) {
        await navigator.clipboard.writeText(body.data.payLink);
        showFlash('Pay link copied to clipboard', true);
      } else {
        showFlash('Could not create a pay link', false);
      }
    } catch {
      showFlash('Could not create a pay link', false);
    }
  }, [showFlash]);

  const handleVoid = useCallback((id: string) => {
    setVoidingId(id);
  }, []);

  async function handleVoidConfirm() {
    if (!voidingId) return;
    setVoidBusy(true);
    try {
      const result = await voidInvoice(voidingId);
      if (result.ok) {
        showFlash('Invoice voided', true);
      } else {
        showFlash(VOID_FAIL[result.reason ?? ''] ?? 'Could not void this invoice.', false);
      }
    } finally {
      setVoidBusy(false);
      setVoidingId(null);
    }
  }

  // Source segmented control options — derived from server sourceCounts.
  // The server returns counts for the current filter (state), so we build
  // the options from what the server reported.
  const sourceOptions = useMemo((): readonly SourceOption[] => {
    const opts: SourceOption[] = [{ value: 'all', label: 'All sources' }];
    if ((sourceCounts['native'] ?? 0) > 0) opts.push({ value: 'native', label: `Native (${sourceCounts['native']})` });
    if ((sourceCounts['fieldpulse'] ?? 0) > 0) opts.push({ value: 'fieldpulse', label: `FieldPulse (${sourceCounts['fieldpulse']})` });
    if ((sourceCounts['housecall'] ?? 0) > 0) opts.push({ value: 'housecall', label: `Housecall (${sourceCounts['housecall']})` });
    return opts;
  }, [sourceCounts]);

  // Server now handles sort and overdue filter — displayRows is exactly what the server returned.
  const displayRows = useMemo(() => invoices, [invoices]);

  // Overdue count badge — derived from server stats
  const overdueCount = stats?.overdueCount ?? 0;

  // Pager drives on server total (server already handles overdue filtering).
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return (
    <PageShell>
      <PageHeader
        title="Invoices"
        subtitle="Collections — who owes you, how overdue, and one tap to chase it."
      />

      <ReconcileBanner />

      {/* Suppress the zero-data band on uncached first load — the skeleton
          stat tiles below own that state (review fix). */}
      {!isLoading && (
        <SummaryBand stats={stats} collectedThisMonthCents={collectedThisMonthCents} />
      )}

      {/* flash / error feedback */}
      {flash && (
        <Alert variant={flash.ok ? 'default' : 'destructive'}>
          <AlertCircle className="size-4" />
          <AlertDescription>{flash.msg}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* segmented filter */}
        <div className="flex gap-1 rounded-xl border bg-card p-1 shadow-sm">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => { setFilter(f.value); setPage(1); }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                filter === f.value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
              {f.value === 'overdue' && overdueCount > 0 && (
                <span className="rounded-full bg-rose-600 px-1.5 py-px text-[10px] font-bold text-white">
                  {overdueCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* source segmented control — hidden when only one source type exists */}
          {sourceOptions.length > 1 && (
            <div className="flex gap-1 rounded-xl border bg-card p-1 shadow-sm">
              {sourceOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setSource(opt.value); setPage(1); }}
                  className={cn(
                    'inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                    source === opt.value
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {/* sort select */}
          <select
            value={sortKey}
            onChange={(e) => { setSortKey(e.target.value as InvoiceSortKey); setPage(1); }}
            className="rounded-xl border bg-card px-3 py-2.5 text-sm font-semibold text-foreground shadow-sm outline-none focus:ring-1 focus:ring-ring"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* search */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 rounded-xl border bg-card px-3 shadow-sm focus-within:ring-1 focus-within:ring-ring">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                className="shrink-0 text-muted-foreground"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="search"
                placeholder="Search customer or invoice ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setDebouncedSearch(''); } }}
                className="bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            {debouncedSearch && (
              <span className="px-1 text-xs text-muted-foreground">
                {total} result{total === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* list */}
      {isLoading ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
          </div>
          <TableSkeleton rows={8} cols={5} />
        </>
      ) : displayRows.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={Receipt}
            title={
              filter === 'all' && !debouncedSearch
                ? 'No invoices yet'
                : filter === 'overdue' && !debouncedSearch
                  ? "You're all caught up"
                  : 'No invoices match'
            }
            description={
              filter === 'all' && !debouncedSearch
                ? 'Generate an invoice from a sold estimate to start collecting payments.'
                : filter === 'overdue' && !debouncedSearch
                  ? 'No overdue invoices right now.'
                  : 'No invoices match this filter. Try a different one.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            {/* header row */}
            <div className="grid grid-cols-[minmax(200px,1fr)_90px_120px_140px_180px] items-center gap-4 bg-foreground px-6 py-2.5">
              {(['Customer', 'Created', 'Age', 'Balance', 'Actions'] as const).map(
                (col) => (
                  <p
                    key={col}
                    className={cn(
                      'text-[10.5px] font-semibold uppercase tracking-widest text-background/60',
                      col === 'Balance' || col === 'Actions' ? 'text-right' : '',
                    )}
                  >
                    {col}
                  </p>
                ),
              )}
            </div>
            {displayRows.map((inv) => (
              <InvoiceRow key={inv.id} invoice={inv} onRemind={handleRemind} onCopyPayLink={handleCopyPayLink} onVoid={handleVoid} pending={pendingId === inv.id} />
            ))}
          </div>

          {/* pager bar */}
          <div className="flex items-center justify-between px-1 py-3 text-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
            >
              ← Prev
            </Button>
            <span className="tabular-nums text-xs text-muted-foreground">
              {pageLabel(safePage, total, PER_PAGE)}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage(1)}
                disabled={safePage <= 1}
              >
                First
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage(totalPages)}
                disabled={safePage >= totalPages}
              >
                Last
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                Next →
              </Button>
            </div>
          </div>
        </>
      )}
      <Dialog open={voidingId !== null} onOpenChange={(open) => { if (!open && !voidBusy) setVoidingId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this invoice?</DialogTitle>
            <DialogDescription>
              {voidingId ? `${invoiceRef(voidingId)} will be marked void and can no longer be collected. This can't be undone.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={voidBusy} onClick={handleVoidConfirm}>
              {voidBusy ? 'Voiding…' : 'Void invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
