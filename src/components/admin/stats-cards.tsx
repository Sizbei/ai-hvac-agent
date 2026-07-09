'use client';

import { useState, useEffect, useRef } from 'react';
import { Clock, UserCheck, Wrench, CheckCircle } from 'lucide-react';
import type { DashboardStats } from '@/lib/admin/types';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardConfig {
  readonly key: keyof DashboardStats;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly bgColor: string;
  readonly iconColor: string;
}

const STAT_CARDS: readonly StatCardConfig[] = [
  {
    key: 'pending',
    label: 'Pending Requests',
    icon: Clock,
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
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
    key: 'completedToday',
    label: 'Completed Today',
    icon: CheckCircle,
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    iconColor: 'text-green-600 dark:text-green-400',
  },
] as const;

const POLL_INTERVAL_MS = 30_000;

export function StatsCards() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    async function fetchStats(): Promise<void> {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      try {
        const res = await fetch('/api/admin/stats');
        if (!res.ok) return;

        const body = (await res.json()) as {
          success: boolean;
          data: DashboardStats;
        };

        if (body.success) {
          setStats(body.data);
        }
      } catch {
        // Silently ignore — stats are non-critical UI elements
      } finally {
        isFetchingRef.current = false;
      }
    }

    setIsLoading(true);
    fetchStats().finally(() => setIsLoading(false));

    const intervalId = setInterval(() => {
      void fetchStats();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {STAT_CARDS.map((config) => {
        const Icon = config.icon;
        return (
          <Card key={config.key} className="p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${config.bgColor}`}>
                <Icon className={`h-5 w-5 ${config.iconColor}`} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{config.label}</p>
                {isLoading || !stats ? (
                  <Skeleton className="h-7 w-10 mt-1" />
                ) : (
                  <p className="text-2xl font-bold">
                    {stats[config.key]}
                    {config.key === 'pending' && (stats.importedPending ?? 0) > 0 && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        +{stats.importedPending} imported
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
