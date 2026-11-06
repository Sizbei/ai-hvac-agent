'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wrench,
  Clock,
  CheckCircle2,
  XCircle,
  Users,
  DollarSign,
  Sunrise,
  RefreshCw,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { DataTableShell } from '@/components/admin/ui/data-table-shell';
import type { OpsInsights } from '@/lib/admin/ops-insights-types';
import {
  formatCents,
  hourLabel,
  peakHour as findPeakHour,
  sortByUrgency,
  timeZoneLabel,
} from '@/lib/admin/ops-insights-format';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import { groupIssueTypes, humanizeCode } from '@/lib/admin/issue-type-label';

const URGENCY_LABELS: Record<string, string> = {
  emergency: 'Emergency',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  assigned: 'Assigned',
  en_route: 'En route',
  arrived: 'Arrived',
  in_progress: 'In progress',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function humanize(value: string, labels: Record<string, string>): string {
  return Object.hasOwn(labels, value) ? labels[value]! : humanizeCode(value);
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
          <ProgressBar
            value={Math.round((r.count / max) * 100)}
            label={`${humanize(r.key, labels)}: ${r.count}`}
            className="h-1.5 flex-1"
          />
          <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums">
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Top issue types plus "Other"; imported job titles are not issue types and are left out. */
function IssueTypeChart({
  rows,
}: {
  readonly rows: readonly { readonly key: string; readonly count: number }[];
}) {
  const { bars, importedTitles } = groupIssueTypes(rows);
  const labels = Object.fromEntries(bars.map((b) => [b.key, b.label]));
  return (
    <>
      <BarList rows={bars} labels={labels} />
      {importedTitles > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {importedTitles} imported request{importedTitles === 1 ? ' has' : 's have'} no issue type and {importedTitles === 1 ? "isn't" : "aren't"} shown.
        </p>
      )}
    </>
  );
}

/** A 24-column bar chart of request volume by hour of day. Peak hour is
 * highlighted; only every third hour is labelled to keep the axis readable. */
function HourHistogram({
  rows,
}: {
  readonly rows: readonly { readonly hour: number; readonly count: number }[];
}) {
  const peakHour = findPeakHour(rows);
  if (peakHour === null) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div>
      <div className="flex h-32 items-end gap-px">
        {rows.map((r) => (
          <div
            key={r.hour}
            // h-full: in an items-end row a column without a height collapses
            // to its content (0 px), so every bar's % height resolved to 0.
            className="group flex h-full flex-1 flex-col items-center justify-end"
            title={`${hourLabel(r.hour)} — ${r.count} request${r.count === 1 ? '' : 's'}`}
          >
            <div
              className={`w-full rounded-t-[2px] ${
                r.hour === peakHour ? 'bg-marker' : 'bg-marker-border'
              }`}
              // Zero-count hours render nothing; non-zero hours get a >=2% floor
              // so a single request is still visible against a tall peak.
              style={{
                height:
                  r.count === 0
                    ? '0%'
                    : `${Math.max(2, Math.round((r.count / max) * 100))}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px">
        {rows.map((r) => (
          <div
            key={r.hour}
            className="flex-1 text-center text-[10px] text-muted-foreground"
          >
            {r.hour % 3 === 0 ? hourLabel(r.hour) : ''}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Busiest hour:{' '}
        <span className="font-medium text-foreground">{hourLabel(peakHour)}</span>
      </p>
    </div>
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
    setError(null);
    try {
      const res = await adminFetch('/api/admin/ops-insights');
      if (!res.ok) {
        setError("Couldn't load the operations numbers.");
        return;
      }
      const body = (await res.json()) as { success: boolean; data: OpsInsights };
      if (body.success) {
        setData(body.data);
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      setError("Couldn't reach the server.");
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchOps().finally(() => setIsLoading(false));
  }, [fetchOps]);

  return (
    <section aria-labelledby="ops-insights-heading" className="space-y-4">
      <SectionHeading as="h2" title="Operations" />

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setError(null); void fetchOps(); }}
            >
              <RefreshCw className="mr-2 size-4" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <StatStrip>
        <StatCard
          icon={Clock}
          label="Open requests"
          value={data?.openRequests ?? 0}
          sublabel={
            data && data.openImported > 0
              ? `${data.openRequests - data.openImported} booked here · ${data.openImported} imported`
              : undefined
          }
          intent="warning"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={data?.completedRequests ?? 0}
          intent="success"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={XCircle}
          label="Cancelled"
          value={data?.cancelledRequests ?? 0}
          intent="neutral"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={Wrench}
          label="New (7 days)"
          value={data?.requestsLast7Days ?? 0}
          intent="info"
          size="sm"
          loading={isLoading}
        />
      </StatStrip>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Requests by issue type</p>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <IssueTypeChart rows={data?.byIssueType ?? []} />
          )}
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Requests by urgency</p>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <BarList rows={sortByUrgency(data?.byUrgency ?? [])} labels={URGENCY_LABELS} />
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
          <DataTableShell
            columns={[
              { key: 'name', header: 'Technician', cell: (row) => row.technicianName ?? <span className="italic text-muted-foreground">Unassigned</span> },
              { key: 'active', header: 'Active', cell: (row) => <span className="font-mono tabular-nums">{row.active}</span>, className: 'text-right' },
              { key: 'completed', header: 'Completed', cell: (row) => <span className="font-mono tabular-nums text-muted-foreground">{row.completed}</span>, className: 'text-right' },
              { key: 'total', header: 'Total', cell: (row) => <span className="font-mono tabular-nums">{row.total}</span>, className: 'text-right' },
            ]}
            rows={data.technicianLoad}
            getRowKey={(row) => row.technicianId ?? 'unassigned'}
            className="border-0 shadow-none"
          />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sunrise className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">Requests by time of day</p>
          </div>
          {data && (
            <p className="-mt-2 mb-3 text-xs text-muted-foreground">
              Requests booked here, by the hour they came in ({timeZoneLabel(data.timeZone)}).
            </p>
          )}
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <HourHistogram rows={data?.requestsByHour ?? []} />
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <DollarSign className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">Recorded service revenue</p>
          </div>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.costStats.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              No service costs recorded yet.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="font-mono text-xl font-medium tabular-nums">
                  {formatCents(data.costStats.totalCents)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg / job</p>
                <p className="font-mono text-xl font-medium tabular-nums">
                  {formatCents(data.costStats.averageCents)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Jobs costed</p>
                <p className="font-mono text-xl font-medium tabular-nums">
                  {data.costStats.count}
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>

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
