'use client';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceStats } from '@/hooks/use-invoices';

export function SummaryBand({
  stats,
  collectedThisMonthCents,
}: {
  stats: InvoiceStats | null;
  collectedThisMonthCents: number;
}) {
  const outstanding = stats?.outstandingCents ?? 0;
  const outstandingCount = stats?.outstandingCount ?? 0;
  const overdueSum = stats?.overdueCents ?? 0;
  const overdueCount = stats?.overdueCount ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums">{formatCentsExact(outstanding)}</p>
        <p className="mt-1 text-xs text-muted-foreground">across {outstandingCount} open invoices</p>
      </div>
      <div className="rounded-xl border border-rose-200 bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overdue</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-rose-600">{formatCentsExact(overdueSum)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {overdueCount} invoices
          {(stats?.oldestOverdueDays ?? 0) > 0 && (
            <> · oldest {Math.round(stats!.oldestOverdueDays)}d past due</>
          )}
        </p>
      </div>
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected this month</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-emerald-700">{formatCentsExact(collectedThisMonthCents)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Payments received since the 1st</p>
      </div>
    </div>
  );
}
