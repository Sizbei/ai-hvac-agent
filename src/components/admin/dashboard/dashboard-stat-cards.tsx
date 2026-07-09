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
import type { DashboardStats } from '@/lib/admin/types';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardConfig {
  readonly key: keyof DashboardStats;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly bgColor: string;
  readonly iconColor: string;
  /** Render the value as a dollar amount. */
  readonly isCurrency?: boolean;
}

const STAT_CARDS: readonly StatCardConfig[] = [
  {
    key: 'pending',
    label: 'Pending',
    icon: Clock,
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
  },
  {
    key: 'scheduled',
    label: 'Scheduled',
    icon: CalendarClock,
    bgColor: 'bg-sky-100 dark:bg-sky-900/30',
    iconColor: 'text-sky-600 dark:text-sky-400',
  },
  {
    key: 'assignedToday',
    label: 'Assigned Today',
    icon: UserCheck,
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
  {
    key: 'inProgress',
    label: 'In Progress',
    icon: Wrench,
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
    iconColor: 'text-purple-600 dark:text-purple-400',
  },
  {
    key: 'onHold',
    label: 'On Hold',
    icon: PauseCircle,
    bgColor: 'bg-slate-100 dark:bg-slate-800/50',
    iconColor: 'text-slate-600 dark:text-slate-300',
  },
  {
    key: 'completedToday',
    label: 'Completed Today',
    icon: CheckCircle,
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    iconColor: 'text-green-600 dark:text-green-400',
  },
  {
    key: 'emergencyOpen',
    label: 'Open Emergencies',
    icon: Siren,
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    iconColor: 'text-red-600 dark:text-red-400',
  },
] as const;

interface DashboardStatCardsProps {
  readonly stats: DashboardStats | null;
  readonly isLoading: boolean;
}

function formatValue(value: number, isCurrency?: boolean): string {
  return isCurrency ? `$${value.toLocaleString()}` : String(value);
}

export function DashboardStatCards({ stats, isLoading }: DashboardStatCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {STAT_CARDS.map((config) => {
        const Icon = config.icon;
        return (
          <Card
            key={config.key}
            className="flex flex-col gap-3 p-5 transition-shadow duration-200 hover:shadow-md hover:ring-1 hover:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {config.label}
              </p>
              <span className={`shrink-0 rounded-lg p-2 ${config.bgColor}`}>
                <Icon className={`h-4 w-4 ${config.iconColor}`} />
              </span>
            </div>
            {isLoading || !stats ? (
              <Skeleton className="h-9 w-14" />
            ) : (
              <p className="font-heading text-3xl font-bold leading-none tracking-tight tabular-nums">
                {formatValue(stats[config.key], config.isCurrency)}
                {config.key === 'pending' && (stats.importedPending ?? 0) > 0 && (
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    +{stats.importedPending} imported
                  </span>
                )}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
