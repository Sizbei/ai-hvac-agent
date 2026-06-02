'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Wrench, Clock, CheckCircle2, XCircle, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { OpsInsights } from '@/lib/admin/ops-insights-types';

const ISSUE_LABELS: Record<string, string> = {
  heating_not_working: 'Heating',
  cooling_not_working: 'Cooling / AC',
  thermostat_issue: 'Thermostat',
  air_quality: 'Air quality',
  strange_noises: 'Noises / diagnostics',
  water_leak: 'Water leak',
  maintenance: 'Maintenance',
  installation: 'Installation',
  other: 'Other',
};

const URGENCY_LABELS: Record<string, string> = {
  emergency: 'Emergency',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function humanize(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replace(/_/g, ' ');
}

/** A simple labelled horizontal bar list — shares of a total. */
function BarList({
  rows,
  labels,
}: {
  readonly rows: readonly { readonly key: string; readonly count: number }[];
  readonly labels: Record<string, string>;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  // Guarded at >= 1 so the width math can never divide by zero.
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-sm">
            {humanize(r.key, labels)}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.round((r.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-sm font-medium">
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  bg,
  fg,
  isLoading,
}: {
  readonly icon: typeof Wrench;
  readonly label: string;
  readonly value: number;
  readonly bg: string;
  readonly fg: string;
  readonly isLoading: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2 ${bg}`}>
          <Icon className={`h-5 w-5 ${fg}`} />
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          {isLoading ? (
            <Skeleton className="mt-1 h-7 w-12" />
          ) : (
            <p className="text-2xl font-bold">{value}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

export function OpsInsightsSection() {
  const [data, setData] = useState<OpsInsights | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchOps = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await fetch('/api/admin/ops-insights');
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch operations insights' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch operations insights');
        return;
      }
      const body = (await res.json()) as { success: boolean; data: OpsInsights };
      if (body.success) {
        setData(body.data);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchOps().finally(() => setIsLoading(false));
  }, [fetchOps]);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Operations</h2>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Clock}
          label="Open requests"
          value={data?.openRequests ?? 0}
          bg="bg-amber-100 dark:bg-amber-900/30"
          fg="text-amber-600 dark:text-amber-400"
          isLoading={isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={data?.completedRequests ?? 0}
          bg="bg-green-100 dark:bg-green-900/30"
          fg="text-green-600 dark:text-green-400"
          isLoading={isLoading}
        />
        <StatCard
          icon={XCircle}
          label="Cancelled"
          value={data?.cancelledRequests ?? 0}
          bg="bg-gray-100 dark:bg-gray-800"
          fg="text-gray-600 dark:text-gray-400"
          isLoading={isLoading}
        />
        <StatCard
          icon={Wrench}
          label="New (7 days)"
          value={data?.requestsLast7Days ?? 0}
          bg="bg-blue-100 dark:bg-blue-900/30"
          fg="text-blue-600 dark:text-blue-400"
          isLoading={isLoading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Requests by issue type</p>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <BarList rows={data?.byIssueType ?? []} labels={ISSUE_LABELS} />
          )}
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Requests by urgency</p>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <BarList rows={data?.byUrgency ?? []} labels={URGENCY_LABELS} />
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">Technician load</p>
        </div>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data || data.technicianLoad.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Technician</th>
                  <th className="pb-2 text-right font-medium">Active</th>
                  <th className="pb-2 text-right font-medium">Completed</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.technicianLoad.map((t) => (
                  <tr
                    key={t.technicianId ?? 'unassigned'}
                    className="border-b last:border-0"
                  >
                    <td className="py-2">
                      {t.technicianName ?? (
                        <span className="italic text-muted-foreground">
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-medium">{t.active}</td>
                    <td className="py-2 text-right text-muted-foreground">
                      {t.completed}
                    </td>
                    <td className="py-2 text-right">{t.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Status breakdown:{' '}
        {data
          ? data.byStatus
              .map((s) => `${humanize(s.key, STATUS_LABELS)} ${s.count}`)
              .join(' · ') || '—'
          : '—'}
      </p>
    </section>
  );
}
