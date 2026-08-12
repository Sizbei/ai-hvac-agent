'use client';

import Link from 'next/link';
import {
  Clock,
  UserCheck,
  Wrench,
  CheckCircle,
  CalendarClock,
  PauseCircle,
  Siren,
  Receipt,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardStats } from '@/lib/admin/types';
import type { DashboardOverdueInvoices } from '@/lib/admin/queries';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { formatCentsExact } from '@/lib/admin/money-format';

interface StatCardConfig {
  readonly key: keyof DashboardStats;
  /** Sentence-case label. */
  readonly label: string;
  readonly icon: LucideIcon;
}

// No per-tile intent: the KPI cell no longer tints (the number is the signal).
const STAT_CARDS: readonly StatCardConfig[] = [
  { key: 'pending', label: 'Pending', icon: Clock },
  { key: 'scheduled', label: 'Scheduled', icon: CalendarClock },
  { key: 'assignedToday', label: 'Assigned today', icon: UserCheck },
  { key: 'inProgress', label: 'In progress', icon: Wrench },
  { key: 'onHold', label: 'On hold', icon: PauseCircle },
  { key: 'completedToday', label: 'Completed today', icon: CheckCircle },
  { key: 'emergencyOpen', label: 'Open emergencies', icon: Siren },
] as const;

interface DashboardStatCardsProps {
  readonly stats: DashboardStats | null;
  /** Overdue-invoices AR signal (Rdashboard-2) — null while loading. */
  readonly overdueInvoices: DashboardOverdueInvoices | null;
  readonly isLoading: boolean;
}

/** Cell class that lets a StatCard sit flush inside a <StatStrip>. */
const IN_STRIP = 'h-full rounded-none border-0 bg-transparent';

export function DashboardStatCards({ stats, overdueInvoices, isLoading }: DashboardStatCardsProps) {
  const cell = (config: StatCardConfig) => {
    const value = stats ? String(stats[config.key]) : '—';
    const sublabel =
      config.key === 'pending' && stats && (stats.importedPending ?? 0) > 0
        ? `+${stats.importedPending} imported`
        : undefined;
    return (
      <StatCard
        key={config.key}
        label={config.label}
        value={value}
        icon={config.icon}
        sublabel={sublabel}
        loading={isLoading}
      />
    );
  };

  // Two fused KPI bands (one container each, internal hairlines, zero gap)
  // rather than eight floating tiles with gutters.
  return (
    <div className="flex flex-col gap-3">
      <StatStrip>{STAT_CARDS.slice(0, 4).map(cell)}</StatStrip>
      <StatStrip>
        {STAT_CARDS.slice(4).map(cell)}

        {/* Overdue-invoices AR signal (Rdashboard-2) — reuses the same overdue
            definition as /admin/invoices and /admin/operations (queries.ts's
            buildDashboardOverdueInvoicesQuery imports invoice-queries.ts's
            overdueWhere directly). Clicking navigates to the collections
            workspace. A real 0 renders "0", not "—" — only the pre-load state
            renders "—". */}
        <Link
          href="/admin/invoices"
          className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <StatCard
            label="Overdue invoices"
            value={overdueInvoices ? String(overdueInvoices.count) : '—'}
            icon={Receipt}
            sublabel={overdueInvoices ? `${formatCentsExact(overdueInvoices.cents)} outstanding` : undefined}
            loading={isLoading}
            className={IN_STRIP}
          />
        </Link>
      </StatStrip>
    </div>
  );
}
