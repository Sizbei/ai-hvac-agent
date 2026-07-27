'use client';

import {
  Clock,
  UserCheck,
  Wrench,
  CheckCircle,
  CalendarClock,
  PauseCircle,
  Siren,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardStats } from '@/lib/admin/types';
import { StatCard, type StatCardIntent } from '@/components/admin/ui/stat-card';

interface StatCardConfig {
  readonly key: keyof DashboardStats;
  /** Sentence-case label. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly intent: StatCardIntent;
}

const STAT_CARDS: readonly StatCardConfig[] = [
  { key: 'pending', label: 'Pending', icon: Clock, intent: 'warning' },
  { key: 'scheduled', label: 'Scheduled', icon: CalendarClock, intent: 'info' },
  { key: 'assignedToday', label: 'Assigned today', icon: UserCheck, intent: 'primary' },
  { key: 'inProgress', label: 'In progress', icon: Wrench, intent: 'info' },
  { key: 'onHold', label: 'On hold', icon: PauseCircle, intent: 'neutral' },
  { key: 'completedToday', label: 'Completed today', icon: CheckCircle, intent: 'success' },
  { key: 'emergencyOpen', label: 'Open emergencies', icon: Siren, intent: 'danger' },
] as const;

interface DashboardStatCardsProps {
  readonly stats: DashboardStats | null;
  readonly isLoading: boolean;
}

export function DashboardStatCards({ stats, isLoading }: DashboardStatCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {STAT_CARDS.map((config) => {
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
            intent={config.intent}
            sublabel={sublabel}
            loading={isLoading}
          />
        );
      })}
    </div>
  );
}
