'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Receipt } from 'lucide-react';
import { useInvoices } from '@/hooks/use-invoices';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SummaryBand } from '@/components/admin/invoices/summary-band';
import { InvoiceRow } from '@/components/admin/invoices/invoice-row';
import { daysBetween } from '@/components/admin/invoices/age-chip';
import { isCollectible } from '@/lib/admin/invoice-collectible';
import type { InvoiceListItem } from '@/hooks/use-invoices';

// ── helpers ──────────────────────────────────────────────────────────────────

function isOverdue(inv: InvoiceListItem): boolean {
  return isCollectible(inv) && daysBetween(new Date(inv.createdAt), new Date()) >= 30;
}

// ── filter types ─────────────────────────────────────────────────────────────

type Filter = 'overdue' | 'all' | 'unpaid' | 'paid';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
];

// ── ReconcileBanner (unchanged from original) ─────────────────────────────────

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
  const { invoices, isLoading, error, sendReminder } = useInvoices();
  const [filter, setFilter] = useState<Filter>('overdue');
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // auto-clear flash after 3s
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  function showFlash(msg: string, ok: boolean) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlash({ msg, ok });
    flashTimerRef.current = setTimeout(() => setFlash(null), 3000);
  }

  const REASON_MAP: Record<string, string> = {
    COOLDOWN: 'A reminder was already sent recently.',
    NO_PHONE: 'No phone number on file for this customer.',
    NO_TEMPLATE: 'No reminder template is configured.',
    NO_BALANCE: 'This invoice has no balance due.',
    NOT_FOUND: 'Invoice not found.',
  };

  async function handleRemind(id: string) {
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
  }

  // count overdue for badge
  const overdueCount = useMemo(
    () => invoices.filter(isOverdue).length,
    [invoices],
  );

  const filtered = useMemo(() => {
    let rows = invoices.slice();

    // filter
    if (filter === 'overdue') rows = rows.filter(isOverdue);
    else if (filter === 'unpaid')
      rows = rows.filter(isCollectible);
    else if (filter === 'paid') rows = rows.filter((i) => i.state === 'paid');

    // search
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (i) =>
          (i.customerName ?? '').toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q),
      );
    }

    // collections sort: oldest open first, paid last
    rows.sort((a, b) => {
      const aPaid = a.state === 'paid' ? 1 : 0;
      const bPaid = b.state === 'paid' ? 1 : 0;
      if (aPaid !== bPaid) return aPaid - bPaid;
      return daysBetween(new Date(b.createdAt), new Date()) - daysBetween(new Date(a.createdAt), new Date());
    });

    return rows;
  }, [invoices, filter, search]);

  return (
    <PageShell>
      <PageHeader
        title="Invoices"
        subtitle="Collections — who owes you, how overdue, and one tap to chase it."
      />

      <ReconcileBanner />

      <SummaryBand invoices={invoices} />

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
              onClick={() => setFilter(f.value)}
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

        {/* search */}
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
            className="bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* list */}
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={Receipt}
            title={
              filter === 'all' && !search
                ? 'No invoices yet'
                : filter === 'overdue' && !search
                  ? "You're all caught up"
                  : 'No invoices match'
            }
            description={
              filter === 'all' && !search
                ? 'Generate an invoice from a sold estimate to start collecting payments.'
                : filter === 'overdue' && !search
                  ? 'No overdue invoices right now.'
                  : 'No invoices match this filter. Try a different one.'
            }
          />
        </Card>
      ) : (
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
          {filtered.map((inv) => (
            <InvoiceRow key={inv.id} invoice={inv} onRemind={handleRemind} pending={pendingId === inv.id} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
