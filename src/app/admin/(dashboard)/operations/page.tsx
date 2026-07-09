'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Clock,
  Wallet,
  ClipboardList,
  UserCheck,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import {
  useOperationsMetrics,
  type MetricTrend,
} from '@/hooks/use-operations-metrics';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatCentsExact } from '@/lib/admin/money-format';

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 365 days', days: 365 },
] as const;

/** Adaptive duration formatter: seconds → the most readable unit. */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.abs(seconds);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} hrs`;
  return `${(s / 86400).toFixed(1)} days`;
}

interface Delta {
  readonly text: string;
  readonly good: boolean;
  readonly up: boolean;
}

/** Period-over-period delta for a duration metric (lower is better). */
function durationDelta(trend: MetricTrend): Delta | null {
  const { current, previous } = trend;
  if (current === null || previous === null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 1) return null;
  return { text: formatDuration(Math.abs(diff)), good: diff < 0, up: diff > 0 };
}

/** Period-over-period delta for a count metric (higher is better), as a percent. */
function countDelta(trend: MetricTrend): Delta | null {
  const { current, previous } = trend;
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return null;
  return { text: `${Math.abs(Math.round(pct))}%`, good: pct > 0, up: pct > 0 };
}

function DeltaPill({ delta, rangeDays }: { delta: Delta | null; rangeDays: number }) {
  if (!delta) return null;
  const Arrow = delta.up ? ArrowUp : ArrowDown;
  // Sentiment must not rely on color alone (colorblind + screen readers). The
  // FULL spoken sentence lives in a real sr-only text node — not an aria-label on
  // a generic span, which ARIA disallows and screen readers announce
  // unreliably. The visual arrow + number + comparison are aria-hidden so AT
  // hears the sr-only sentence exactly once.
  const sentiment = delta.good ? 'improved' : 'worse';
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="sr-only">
        {sentiment} by {delta.text} versus the previous {rangeDays} days
      </span>
      <span
        aria-hidden="true"
        className={
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ' +
          (delta.good
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
            : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400')
        }
      >
        <Arrow className="size-3" />
        {delta.text}
      </span>
      <span className="text-xs text-muted-foreground" aria-hidden="true">
        vs prev {rangeDays} days
      </span>
    </div>
  );
}

interface KpiCardProps {
  readonly label: string;
  readonly icon: typeof Clock;
  readonly value: string | null;
  readonly delta: Delta | null;
  readonly rangeDays: number;
  readonly foot?: React.ReactNode;
  readonly isLoading: boolean;
  readonly children?: React.ReactNode;
}

function KpiCard({
  label,
  icon: Icon,
  value,
  delta,
  rangeDays,
  foot,
  isLoading,
  children,
}: KpiCardProps) {
  return (
    <Card className="flex flex-col gap-0 p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-4 text-primary" />
        {label}
      </div>
      {isLoading ? (
        <Skeleton className="mt-3 h-9 w-28" />
      ) : (
        <div className="mt-3 font-heading text-[2.1rem] font-bold leading-none tracking-tight tabular-nums">
          {value ?? '—'}
        </div>
      )}
      {!isLoading && <DeltaPill delta={delta} rangeDays={rangeDays} />}
      {children}
      {foot && (
        <div className="mt-auto border-t border-dashed border-border pt-3 text-xs text-muted-foreground">
          {foot}
        </div>
      )}
    </Card>
  );
}

export default function OperationsPage() {
  const [days, setDays] = useState<number>(30);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const { metrics, isLoading, error } = useOperationsMetrics(range);
  const aging = metrics?.arAging;
  const agingTotal = aging?.totalOutstandingCents ?? 0;
  const agingPct = (cents: number) =>
    agingTotal > 0 ? Math.round((cents / agingTotal) * 100) : 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            Operations
          </h1>
          <p className="text-sm text-muted-foreground">
            How fast you reach customers, how long jobs take, and how quickly you
            get paid.
          </p>
        </div>
        <div className="flex gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.days}
              variant={days === preset.days ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDays(preset.days)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Top row: 3 headline KPIs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          label="Response time"
          icon={Clock}
          value={metrics ? formatDuration(metrics.responseTimeSeconds.current) : null}
          delta={metrics ? durationDelta(metrics.responseTimeSeconds) : null}
          rangeDays={days}
          isLoading={isLoading}
          foot={
            <>
              Median booking → on-site · On-site duration{' '}
              <span className="font-semibold text-foreground">
                {formatDuration(metrics?.onSiteSeconds ?? null)}
              </span>
            </>
          }
        />
        <KpiCard
          label="Avg time to paid"
          icon={Wallet}
          value={metrics ? formatDuration(metrics.timeToPaidSeconds.current) : null}
          delta={metrics ? durationDelta(metrics.timeToPaidSeconds) : null}
          rangeDays={days}
          isLoading={isLoading}
          foot="Native invoices only · synced FieldPulse/HCP excluded"
        />
        <KpiCard
          label="Jobs booked"
          icon={ClipboardList}
          value={
            metrics
              ? String(metrics.jobsBooked.current ?? 0) +
                ((metrics.importedJobsCurrent ?? 0) > 0
                  ? ` +${metrics.importedJobsCurrent} imported`
                  : '')
              : null
          }
          delta={metrics ? countDelta(metrics.jobsBooked) : null}
          rangeDays={days}
          isLoading={isLoading}
          foot={
            metrics
              ? `Native service requests · ${(
                  (metrics.jobsBooked.current ?? 0) / Math.max(1, metrics.rangeDays)
                ).toFixed(1)} / day avg`
              : undefined
          }
        />
      </div>

      {/* Second row: first response + AR aging */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <KpiCard
          label="First response · dispatcher"
          icon={UserCheck}
          value={
            metrics ? formatDuration(metrics.firstResponseHumanSeconds.current) : null
          }
          delta={metrics ? durationDelta(metrics.firstResponseHumanSeconds) : null}
          rangeDays={days}
          isLoading={isLoading}
          foot={
            <>
              Created → a dispatcher assigns the job · auto-dispatch{' '}
              <span className="font-semibold text-foreground">
                {formatDuration(metrics?.firstResponseSystemSeconds ?? null)}
              </span>
            </>
          }
        />

        <Card className="p-5">
          <div className="text-sm font-semibold">
            Accounts receivable — open balance
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Outstanding on unpaid invoices, by age
          </p>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : (
            <>
              {[
                { tag: '0–30 d', cents: aging?.bucket0to30Cents ?? 0, bar: 'bg-emerald-500' },
                { tag: '31–60 d', cents: aging?.bucket31to60Cents ?? 0, bar: 'bg-amber-500' },
                { tag: '60+ d', cents: aging?.bucket60PlusCents ?? 0, bar: 'bg-rose-500' },
              ].map((b) => (
                <div key={b.tag} className="mb-3 flex items-center gap-3">
                  <span className="w-16 text-xs font-semibold text-muted-foreground">
                    {b.tag}
                  </span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={'block h-full rounded-full ' + b.bar}
                      style={{ width: `${agingPct(b.cents)}%` }}
                    />
                  </span>
                  <span className="w-20 text-right text-sm font-semibold tabular-nums">
                    {formatCentsExact(b.cents)}
                  </span>
                </div>
              ))}
              <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Total outstanding
                </span>
                <span className="font-heading text-xl font-bold tabular-nums">
                  {formatCentsExact(agingTotal)}
                </span>
              </div>
              {(metrics?.syncedArTotalCents ?? 0) > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  FieldPulse AR:{' '}
                  <span className="font-semibold text-foreground">
                    {formatCentsExact(metrics!.syncedArTotalCents)}
                  </span>{' '}
                  across {metrics!.syncedArCount} invoice
                  {metrics!.syncedArCount !== 1 ? 's' : ''} — managed in
                  FieldPulse
                </p>
              )}
            </>
          )}
        </Card>
      </div>

      <p className="max-w-2xl text-xs text-muted-foreground">
        Trend arrows compare the selected window against the immediately preceding
        window of equal length. Metrics with no data show “—”, never a misleading
        zero.
      </p>
    </div>
  );
}
