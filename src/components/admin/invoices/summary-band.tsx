'use client';
import { formatCentsExact } from '@/lib/admin/money-format';
import { isCollectible } from '@/lib/admin/invoice-collectible';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { daysPastDue, invoiceAgeDays, overdueByDates } from './age-chip';
export function SummaryBand({
  invoices,
  collectedThisMonthCents,
}: {
  invoices: readonly InvoiceListItem[];
  collectedThisMonthCents: number;
}) {
  const open = invoices.filter(isCollectible);
  const outstanding = open.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  const overdue = open.filter(i => overdueByDates(i));
  const overdueSum = overdue.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  // "Oldest" speaks days-past-due when the source gave a due date (the real
  // collections number), else age since issue.
  const oldest = overdue.reduce((m, i) => Math.max(m, i.dueDate ? daysPastDue(i) : invoiceAgeDays(i)), 0);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums">{formatCentsExact(outstanding)}</p>
        <p className="mt-1 text-xs text-muted-foreground">across {open.length} open invoices</p>
      </div>
      <div className="rounded-xl border border-rose-200 bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overdue</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-rose-600">{formatCentsExact(overdueSum)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{overdue.length} invoices{oldest ? ` · oldest ${oldest} days` : ''}</p>
      </div>
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected this month</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-emerald-700">{formatCentsExact(collectedThisMonthCents)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Payments received since the 1st</p>
      </div>
    </div>
  );
}
