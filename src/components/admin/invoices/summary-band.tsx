'use client';
import { Wallet, AlertTriangle, TrendingUp } from 'lucide-react';
import { formatCentsExact } from '@/lib/admin/money-format';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import type { InvoiceStats } from '@/hooks/use-invoices';
import { collectedThisMonthSublabel } from '@/lib/admin/invoice-list-helpers';

export function SummaryBand({
  stats,
  collectedThisMonthCents,
  hasSyncedInvoices = false,
}: {
  stats: InvoiceStats | null;
  collectedThisMonthCents: number;
  hasSyncedInvoices?: boolean;
}) {
  const outstanding = stats?.outstandingCents ?? 0;
  const outstandingCount = stats?.outstandingCount ?? 0;
  const overdueSum = stats?.overdueCents ?? 0;
  const overdueCount = stats?.overdueCount ?? 0;
  const oldestOverdueDays = stats?.oldestOverdueDays ?? 0;

  return (
    <StatStrip>
      <StatCard
        icon={Wallet}
        label="Outstanding"
        value={formatCentsExact(outstanding)}
        sublabel={`Across ${outstandingCount} open ${outstandingCount === 1 ? 'invoice' : 'invoices'}`}
      />
      <StatCard
        icon={AlertTriangle}
        label="Overdue"
        value={formatCentsExact(overdueSum)}
        sublabel={
          oldestOverdueDays > 0
            ? `${overdueCount} ${overdueCount === 1 ? 'invoice' : 'invoices'} · oldest ${Math.round(oldestOverdueDays)}d past due`
            : `${overdueCount} ${overdueCount === 1 ? 'invoice' : 'invoices'}`
        }
      />
      <StatCard
        icon={TrendingUp}
        label="Collected this month"
        value={formatCentsExact(collectedThisMonthCents)}
        sublabel={collectedThisMonthSublabel(hasSyncedInvoices)}
      />
    </StatStrip>
  );
}
