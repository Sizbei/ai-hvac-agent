'use client';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { daysBetween } from './age-chip';
export function SummaryBand({ invoices }: { invoices: readonly InvoiceListItem[] }) {
  const open = invoices.filter(i => i.state !== 'paid' && i.totalCents - i.amountPaidCents > 0);
  const outstanding = open.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  const overdue = open.filter(i => daysBetween(new Date(i.createdAt), new Date()) >= 30);
  const overdueSum = overdue.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  const oldest = overdue.reduce((m, i) => Math.max(m, daysBetween(new Date(i.createdAt), new Date())), 0);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums">{formatCentsExact(outstanding)}</p>
        <p className="mt-1 text-xs text-muted-foreground">across {open.length} open invoices</p>
      </div>
      <div className="rounded-xl border border-rose-200 bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overdue &gt; 30 days</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-rose-600">{formatCentsExact(overdueSum)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{overdue.length} invoices{oldest ? ` · oldest ${oldest} days` : ''}</p>
      </div>
    </div>
  );
}
