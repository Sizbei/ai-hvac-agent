'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Clock,
  Wallet,
  ClipboardList,
  UserCheck,
  Loader2,
  Zap,
} from 'lucide-react';
import {
  useOperationsMetrics,
  type MetricTrend,
} from '@/hooks/use-operations-metrics';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { SectionCard } from '@/components/admin/ui/section-card';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';

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

/** "Response time" sublabel: what the median measures, plus time on site when known. */
function responseSublabel(onSiteSeconds: number | null): string {
  const base = 'Median from booking to a technician on site';
  return onSiteSeconds === null ? base : `${base} · ${formatDuration(onSiteSeconds)} avg on site`;
}

interface DeltaShape {
  readonly text: string;
  readonly good: boolean;
  readonly up: boolean;
}

/** Period-over-period delta for a duration metric (lower is better). */
function durationDelta(trend: MetricTrend): DeltaShape | null {
  const { current, previous } = trend;
  if (current === null || previous === null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 1) return null;
  return { text: formatDuration(Math.abs(diff)), good: diff < 0, up: diff > 0 };
}

/** Period-over-period delta for a count metric (higher is better), as a percent. */
function countDelta(trend: MetricTrend): DeltaShape | null {
  const { current, previous } = trend;
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return null;
  return { text: `${Math.abs(Math.round(pct))}%`, good: pct > 0, up: pct > 0 };
}

/** Converts a DeltaShape to the StatCard delta prop shape. */
function toStatDelta(delta: DeltaShape | null, rangeDays: number): { value: string; good: boolean } | undefined {
  if (!delta) return undefined;
  // No glyph here — StatCard renders the ▲/▼ from `good`. A second hand-rolled
  // arrow would double up (and could disagree with the sentiment colour).
  return { value: `${delta.text} vs prev ${rangeDays}d`, good: delta.good };
}

export default function OperationsPage() {
  useEffect(() => { document.title = 'Operations · Spears Admin'; }, []);
  const [days, setDays] = useState<number>(30);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const { metrics, isLoading, isRevalidating, error } = useOperationsMetrics(range);
  const aging = metrics?.arAging;
  const agingTotal = aging?.nativeOutstandingCents ?? 0;
  const agingPct = (cents: number) =>
    agingTotal > 0 ? Math.round((cents / agingTotal) * 100) : 0;

  return (
    <PageShell>
      <PageHeader
        title="Operations"
        subtitle="How fast you reach customers, how long jobs take, and how quickly you get paid."
        actions={
          <div className="flex gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.days}
                variant={days === preset.days ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDays(preset.days)}
              >
                {days === preset.days && isRevalidating && (
                  <Loader2 className="mr-1.5 size-3 animate-spin" aria-hidden="true" />
                )}
                {preset.label}
              </Button>
            ))}
          </div>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Top row: 3 headline KPIs */}
      <StatStrip>
        <StatCard
          label="Response time"
          icon={Clock}
          value={metrics ? formatDuration(metrics.responseTimeSeconds.current) : '—'}
          delta={metrics ? toStatDelta(durationDelta(metrics.responseTimeSeconds), days) : undefined}
          intent="neutral"
          loading={isLoading}
          sublabel={metrics ? responseSublabel(metrics.onSiteSeconds ?? null) : undefined}
        />
        <StatCard
          label="Avg time to paid"
          icon={Wallet}
          value={metrics ? formatDuration(metrics.timeToPaidSeconds.current) : '—'}
          delta={metrics ? toStatDelta(durationDelta(metrics.timeToPaidSeconds), days) : undefined}
          intent="neutral"
          loading={isLoading}
          sublabel="Your invoices only · synced FieldPulse/HCP excluded"
        />
        <StatCard
          label="Requests booked"
          icon={ClipboardList}
          value={metrics ? String(metrics.jobsBooked.current ?? 0) : '—'}
          delta={metrics ? toStatDelta(countDelta(metrics.jobsBooked), days) : undefined}
          intent="neutral"
          loading={isLoading}
          sublabel={
            metrics
              ? `Native service requests · ${(
                  (metrics.jobsBooked.current ?? 0) / Math.max(1, metrics.rangeDays)
                ).toFixed(1)} / day avg` +
                ((metrics.importedJobsCurrent ?? 0) > 0
                  ? ` · +${metrics.importedJobsCurrent} imported`
                  : '')
              : undefined
          }
        />
      </StatStrip>

      {/* Second row: first response + dispatch health */}
      <StatStrip>
        <StatCard
          label="First response — dispatcher"
          icon={UserCheck}
          value={metrics ? formatDuration(metrics.firstResponseHumanSeconds.current) : '—'}
          delta={metrics ? toStatDelta(durationDelta(metrics.firstResponseHumanSeconds), days) : undefined}
          intent="neutral"
          loading={isLoading}
          sublabel={
            metrics
              ? `Average wait for a dispatcher to assign a new request · auto-dispatch ${formatDuration(metrics.firstResponseSystemSeconds ?? null)}`
              : undefined
          }
        />

        <StatCard
          label="Dispatch health"
          icon={Zap}
          value={
            metrics && metrics.dispatchHealth.commitRate !== null
              ? `${Math.round(metrics.dispatchHealth.commitRate * 100)}%`
              : '—'
          }
          intent="neutral"
          loading={isLoading}
          sublabel={
            metrics
              ? `Commit rate (7d, real + preview) · ${metrics.dispatchHealth.real.total} real · ${metrics.dispatchHealth.shadow.total} preview · ${metrics.dispatchHealth.overrides} overrides`
              : undefined
          }
        />
      </StatStrip>

      {/* AR aging — full width card */}
      <SectionCard
        title="Accounts receivable — open balance"
        description="Outstanding on unpaid invoices, by age."
      >
        {isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-16" />
                <ProgressBar value={0} className="flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {[
                { tag: '0–30 d', cents: aging?.bucket0to30Cents ?? 0, intent: 'success' as const, label: '0 to 30 days' },
                { tag: '31–60 d', cents: aging?.bucket31to60Cents ?? 0, intent: 'warning' as const, label: '31 to 60 days' },
                { tag: '60+ d', cents: aging?.bucket60PlusCents ?? 0, intent: 'danger' as const, label: '60 or more days' },
              ].map((b) => (
                <div key={b.tag} className="flex items-center gap-3">
                  <span className="w-16 text-xs font-semibold text-muted-foreground">
                    {b.tag}
                  </span>
                  <ProgressBar
                    value={agingPct(b.cents)}
                    intent={b.intent}
                    label={`${b.label}: ${formatCentsExact(b.cents)}`}
                    className="flex-1"
                  />
                  <span className="w-28 shrink-0 text-right font-mono text-sm tabular-nums">
                    {formatCentsExact(b.cents)}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <SectionHeading
                as="h3"
                title="Total outstanding"
                right={
                  <span className="font-mono text-xl font-medium tabular-nums">
                    {formatCentsExact(metrics?.totalOutstandingAllCents ?? agingTotal)}
                  </span>
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Native {formatCentsExact(agingTotal)} · Synced (FieldPulse/HCP){' '}
                {formatCentsExact(metrics?.syncedArTotalCents ?? 0)} — collected in the external system
              </p>
            </div>

            {(metrics?.syncedArTotalCents ?? 0) > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <SectionHeading
                  as="h3"
                  title="Synced (FieldPulse/HCP) — by due date"
                  className="mb-3"
                />
                <div className="space-y-2">
                  {[
                    { tag: 'Current', cents: metrics!.syncedArAging.currentCents, intent: 'info' as const, label: 'Current' },
                    { tag: '1–30 d over', cents: metrics!.syncedArAging.overdue1to30Cents, intent: 'success' as const, label: '1 to 30 days overdue' },
                    { tag: '31–60 d over', cents: metrics!.syncedArAging.overdue31to60Cents, intent: 'warning' as const, label: '31 to 60 days overdue' },
                    { tag: '60+ d over', cents: metrics!.syncedArAging.overdue60PlusCents, intent: 'danger' as const, label: '60 or more days overdue' },
                  ].map((b) => (
                    <div key={b.tag} className="flex items-center gap-3">
                      <span className="w-24 text-xs font-semibold text-muted-foreground">
                        {b.tag}
                      </span>
                      <ProgressBar
                        value={
                          metrics!.syncedArAging.totalOutstandingCents > 0
                            ? Math.round((b.cents / metrics!.syncedArAging.totalOutstandingCents) * 100)
                            : 0
                        }
                        intent={b.intent}
                        label={`${b.label}: ${formatCentsExact(b.cents)}`}
                        className="flex-1"
                      />
                      <span className="w-28 shrink-0 text-right font-mono text-sm tabular-nums">
                        {formatCentsExact(b.cents)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatCentsExact(metrics!.syncedArTotalCents)} across{' '}
                  {metrics!.syncedArCount} invoice
                  {metrics!.syncedArCount !== 1 ? 's' : ''} — collected in the
                  source system
                </p>
              </div>
            )}
          </>
        )}
      </SectionCard>

      <p className="max-w-2xl text-xs text-muted-foreground">
        Where a trend shows, it compares the selected window with the window of
        equal length just before it. Metrics with no data show &ldquo;&mdash;&rdquo;, never a
        misleading zero.
      </p>
    </PageShell>
  );
}
