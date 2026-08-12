'use client';

import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useFpImportStatus } from '@/hooks/use-fp-import-status';
import {
  latestRunPerPhase,
  progressPct,
  formatElapsed,
  runTone,
  isStaleRun,
  PIPELINE_PHASES,
  type FpImportRunSummary,
  type FpRunCounts,
} from '@/components/admin/fp-import/import-status-model';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function StatusChip({ status, isStale }: { status?: string; isStale?: boolean }) {
  if (isStale) {
    return (
      <span className="inline-flex h-5 items-center rounded-[3px] border border-warning-border bg-warning-light px-2 text-[11px] font-medium text-warning-strong">
        Stale
      </span>
    );
  }

  const tone = runTone(status ?? '');
  const label =
    status === 'running'
      ? 'Running'
      : status === 'completed'
        ? 'Completed'
        : status === 'failed'
          ? 'Failed'
          : 'Not started';

  const chipClass = cn(
    'inline-flex h-5 items-center rounded-[3px] border px-2 text-[11px] font-medium',
    tone === 'info' && 'border-info-border bg-info-light text-info-strong',
    tone === 'positive' && 'border-success-border bg-success-light text-success-strong',
    tone === 'destructive' && 'border-danger-border bg-danger-light text-danger-strong',
    tone === 'muted' && 'border-border bg-surface-raised text-muted-foreground',
    status === 'running' && 'skeleton-breathe',
  );

  return <span className={chipClass}>{label}</span>;
}

function ProgressBar({ pct, isRunning }: { pct: number | null; isRunning: boolean }) {
  if (pct !== null) {
    return (
      <div
        className="h-1.5 w-full overflow-hidden rounded-[2px] bg-surface-sunken"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-[2px] bg-marker transition-[width] duration-700 motion-reduce:transition-none"
          style={{ width: `${pct}%`, transitionTimingFunction: 'var(--ease-out)' }}
        />
      </div>
    );
  }
  if (isRunning) {
    // Indeterminate: a breathing slab, the one loading animation in the system.
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-[2px] bg-surface-sunken">
        <div className="skeleton-breathe h-full w-1/3 rounded-[2px] bg-marker-border" />
      </div>
    );
  }
  return null;
}

function TalliesRow({ counts }: { counts: FpRunCounts }) {
  const { fetched = 0, created = 0, updated = 0, skipped = 0, errors = 0 } = counts;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span>Fetched: {fetched}</span>
      <span>Created: {created}</span>
      <span>Updated: {updated}</span>
      <span>Skipped: {skipped}</span>
      <span className={cn(errors > 0 && 'font-medium text-destructive')}>
        Errors: {errors}
      </span>
    </div>
  );
}

function ElapsedTime({
  run,
  isRunning,
}: {
  run: FpImportRunSummary;
  isRunning: boolean;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const elapsed = formatElapsed(run.startedAt, run.finishedAt);
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      Elapsed: {elapsed}
    </p>
  );
}

function RecentRunsTable({
  runs,
  asOfMs,
}: {
  runs: readonly FpImportRunSummary[];
  asOfMs: number;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No import runs yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="border-b border-border-strong bg-surface-sunken">
          <tr>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground">Phase</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground">Status</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground tabular-nums">Fetched</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground tabular-nums">Created</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground tabular-nums">Errors</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground">Started</th>
            <th scope="col" className="px-3 py-2 text-left text-[11px] text-muted-foreground tabular-nums">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((run) => {
            const counts = run.counts as FpRunCounts;
            const stale = isStaleRun(run, asOfMs);
            return (
              <tr key={run.id} className="hover:bg-row-hover">
                <td className="px-3 py-2 capitalize">{run.phase}</td>
                <td className="px-3 py-2">
                  <StatusChip status={run.status} isStale={stale} />
                </td>
                <td className="px-3 py-2 tabular-nums">{counts.fetched ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{counts.created ?? 0}</td>
                <td
                  className={cn(
                    'px-3 py-2 tabular-nums',
                    (counts.errors ?? 0) > 0 && 'text-destructive',
                  )}
                >
                  {counts.errors ?? 0}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {new Date(run.startedAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {formatElapsed(run.startedAt, run.finishedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function FieldpulseImportPage() {
  const { runs: rawRuns, isLoading, error, refresh, isPolling, asOfMs } = useFpImportStatus();
  const runs = rawRuns as readonly FpImportRunSummary[];

  const latestPerPhase = latestRunPerPhase(runs);

  if (isLoading && runs.length === 0) {
    return (
      <PageShell>
        <PageHeader title="FieldPulse import" subtitle="Live import progress by phase" />
        <SkeletonTable rows={4} cols={4} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="FieldPulse import"
        subtitle={isPolling ? 'Live import progress by phase' : 'Import progress by phase'}
        actions={
          !isPolling ? (
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
          ) : undefined
        }
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PIPELINE_PHASES.map((phase) => {
          const run = latestPerPhase[phase];
          const counts = (run?.counts ?? {}) as FpRunCounts;
          const pct = run ? progressPct(counts) : null;
          const isRunning = run?.status === 'running';
          const stale = run ? isStaleRun(run, asOfMs) : false;

          return (
            <Card key={phase}>
              <CardContent className="space-y-3 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <SectionHeading as="h2" title={phase} className="capitalize" />
                  <StatusChip status={run?.status} isStale={stale} />
                </div>
                {run ? (
                  <>
                    <ProgressBar pct={pct} isRunning={isRunning} />
                    <TalliesRow counts={counts} />
                    <ElapsedTime run={run} isRunning={isRunning} />
                    {run.error && (
                      <p className="break-words text-xs text-destructive">{run.error}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No runs yet</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div>
        <SectionHeading title="Recent runs" className="mb-3" />
        <RecentRunsTable runs={runs} asOfMs={asOfMs} />
      </div>
    </PageShell>
  );
}
