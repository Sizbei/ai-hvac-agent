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
  MessagesSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardStats } from '@/lib/admin/types';
import type { DashboardOverdueInvoices } from '@/lib/admin/queries';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { formatCentsExact } from '@/lib/admin/money-format';
import { importedSuffix, openRequestCaption, openRequestTotals } from '@/lib/admin/open-requests';
import { NEEDS_ACTION_INBOX_HREF } from '@/lib/admin/conversation-display';

interface StatCardConfig {
  readonly key: keyof DashboardStats;
  /** Sentence-case label. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** Imported (FieldPulse/HCP) count in the same bucket → "N imported". */
  readonly importedKey?: keyof DashboardStats;
  /** Requests-page filter the tile opens (single-status tiles only). */
  readonly status?: string;
}

// No per-tile intent: the KPI cell no longer tints (the number is the signal).
// The first five tiles partition "open requests" (src/lib/admin/open-requests.ts).
const STAT_CARDS: readonly StatCardConfig[] = [
  { key: 'pending', label: 'Pending', icon: Clock, importedKey: 'importedPending', status: 'pending' },
  { key: 'scheduled', label: 'Scheduled', icon: CalendarClock, importedKey: 'importedScheduled', status: 'scheduled' },
  { key: 'assigned', label: 'Assigned', icon: UserCheck, importedKey: 'importedAssigned', status: 'assigned' },
  { key: 'inProgress', label: 'In progress', icon: Wrench, importedKey: 'importedInProgress' },
  { key: 'onHold', label: 'On hold', icon: PauseCircle, importedKey: 'importedOnHold', status: 'on_hold' },
  { key: 'completedToday', label: 'Completed today', icon: CheckCircle },
  { key: 'emergencyOpen', label: 'Open emergencies', icon: Siren },
] as const;

/**
 * Two columns on phones (one tile per row was ~560 px of scrolling); the strip's
 * own dividers are redrawn for the 2×N grid and reset at `sm`.
 */
const PHONE_GRID =
  'grid-cols-2 sm:grid-cols-none ' +
  '[&>*:nth-child(2)]:shadow-[inset_1px_0_0_var(--border)] ' +
  '[&>*:nth-child(2n+4)]:shadow-[inset_1px_0_0_var(--border),inset_0_1px_0_var(--border)] ' +
  'sm:[&>*:nth-child(2)]:shadow-[inset_1px_0_0_var(--border)] ' +
  'sm:[&>*:nth-child(2n+4)]:shadow-[inset_1px_0_0_var(--border)]';

const LINK_CLASSES =
  'block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

interface DashboardStatCardsProps {
  readonly stats: DashboardStats | null;
  /** Overdue-invoices AR signal (Rdashboard-2) — null while loading. */
  readonly overdueInvoices: DashboardOverdueInvoices | null;
  /** Inbox "Needs action" count (same query as the inbox) — null while loading. */
  readonly conversationsNeedingAction: number | null;
  readonly isLoading: boolean;
}

/** Cell class that lets a StatCard sit flush inside a <StatStrip>. */
const IN_STRIP = 'h-full rounded-none border-0 bg-transparent';

export function DashboardStatCards({
  stats,
  overdueInvoices,
  conversationsNeedingAction,
  isLoading,
}: DashboardStatCardsProps) {
  const cell = (config: StatCardConfig) => {
    // The headline is every open request in the status — what the tile's link
    // opens — so an org whose work is all imported doesn't read a wall of zeros.
    const value = stats
      ? String(stats[config.key] + (config.importedKey ? (stats[config.importedKey] ?? 0) : 0))
      : '—';
    const sublabel =
      stats && config.importedKey
        ? importedSuffix(stats[config.importedKey] ?? 0)
        : config.key === 'emergencyOpen' && conversationsNeedingAction
          ? // An escalated gas-smell chat is not a request yet; don't let
            // "0" here read as "nothing urgent".
            `+${conversationsNeedingAction} escalated conversation${conversationsNeedingAction === 1 ? '' : 's'}`
          : undefined;
    const card = (
      <StatCard
        key={config.key}
        label={config.label}
        value={value}
        icon={config.icon}
        sublabel={sublabel}
        loading={isLoading}
        className={config.status ? IN_STRIP : undefined}
      />
    );
    return config.status ? (
      <Link key={config.key} href={`/admin/requests?status=${config.status}`} className={LINK_CLASSES}>
        {card}
      </Link>
    ) : (
      card
    );
  };

  // Two fused KPI bands (one container each, internal hairlines, zero gap)
  // rather than eight floating tiles with gutters.
  return (
    <div className="flex flex-col gap-3">
      {stats && (
        <p className="text-xs text-muted-foreground">
          {openRequestCaption(openRequestTotals(stats))}
        </p>
      )}
      <StatStrip className={PHONE_GRID}>{STAT_CARDS.slice(0, 4).map(cell)}</StatStrip>
      <StatStrip className={PHONE_GRID}>
        {STAT_CARDS.slice(4).map(cell)}

        {/* Escalated conversations nobody has handled — the inbox's "Needs
            action" definition (conversation-queries buildNeedsActionCountQuery);
            opens the inbox with that filter on. */}
        <Link href={NEEDS_ACTION_INBOX_HREF} className={LINK_CLASSES}>
          <StatCard
            label="Conversations need action"
            value={conversationsNeedingAction === null ? '—' : String(conversationsNeedingAction)}
            icon={MessagesSquare}
            sublabel={conversationsNeedingAction ? 'Escalated, not handled' : undefined}
            loading={isLoading}
            className={IN_STRIP}
          />
        </Link>

        {/* Overdue-invoices AR signal (Rdashboard-2) — reuses the same overdue
            definition as /admin/invoices and /admin/operations (queries.ts's
            buildDashboardOverdueInvoicesQuery imports invoice-queries.ts's
            overdueWhere directly). Clicking navigates to the collections
            workspace. A real 0 renders "0", not "—" — only the pre-load state
            renders "—". */}
        <Link href="/admin/invoices" className={LINK_CLASSES}>
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
