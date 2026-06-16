'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, AlertTriangle, Receipt } from 'lucide-react';
import { useInvoices } from '@/hooks/use-invoices';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { cn } from '@/lib/utils';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type Filter = 'all' | 'unpaid' | 'paid';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid / open' },
  { value: 'paid', label: 'Paid' },
];

interface StuckPayment {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
}

/**
 * "Needs attention" banner — surfaces stranded ('pending') payments that may
 * have moved money without completing locally. Operator can reconcile on demand
 * (the daily cron is the automatic safety net). Self-fetching so it adds no
 * coupling to the invoices list.
 */
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

export default function InvoicesPage() {
  const { invoices, isLoading, error } = useInvoices();
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return invoices;
    if (filter === 'paid') return invoices.filter((i) => i.state === 'paid');
    // 'unpaid' — the thin overdue surface: open/draft invoices with a balance.
    return invoices.filter(
      (i) =>
        (i.state === 'open' || i.state === 'draft') &&
        i.amountPaidCents < i.totalCents,
    );
  }, [invoices, filter]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Invoices generated from sold estimates, with payments and refunds.
        </p>
      </div>

      <ReconcileBanner />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            variant={filter === f.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <Receipt className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            {filter === 'all'
              ? 'No invoices yet. Generate one from a sold estimate.'
              : 'No invoices match this filter.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Balance</th>
                <th className="px-4 py-2 font-medium">Links</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const balance = inv.totalCents - inv.amountPaidCents;
                return (
                  <tr key={inv.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">{formatDate(inv.createdAt)}</td>
                    <td className="px-4 py-3">
                      <InvoiceStateBadge state={inv.state} />
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {formatCentsExact(inv.totalCents)}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3',
                        balance > 0 ? 'font-medium text-amber-700' : 'text-muted-foreground',
                      )}
                    >
                      {formatCentsExact(balance)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {inv.customerId && (
                        <Link
                          href={`/admin/customers/${inv.customerId}`}
                          className="hover:underline"
                        >
                          Customer
                        </Link>
                      )}
                      {inv.customerId && inv.serviceRequestId && ' · '}
                      {inv.serviceRequestId && (
                        <Link
                          href={`/admin/requests?request=${inv.serviceRequestId}`}
                          className="hover:underline"
                        >
                          Request
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/admin/invoices/${inv.id}`}>
                        <Button variant="outline" size="sm">
                          View
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
