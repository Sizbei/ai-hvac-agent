'use client';

import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useFpImportStatus } from '@/hooks/use-fp-import-status';
import {
  latestRunPerPhase,
  progressPct,
  formatElapsed,
  runTone,
  type FpImportRunSummary,
  type FpRunCounts,
} from '@/components/admin/fp-import/import-status-model';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PIPELINE_ORDER = ['technicians', 'customers', 'jobs', 'invoices'] as const;

function StatusChip({ status }: { status?: string }) {
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
    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
    tone === 'info' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    tone === 'positive' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    tone === 'destructive' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    tone === 'muted' && 'bg-muted text-muted-foreground',
    status === 'running' && 'animate-pulse motion-reduce:animate-none',
  );

  // SINGLE TEXT NODE — no nested spans inside the chip
  return <span className={chipClass}>{label}</span>;
}

function ProgressBar({ pct, isRunning }: { pct: number | null; isRunning: boolean }) {
  if (pct !== null) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 motion-reduce:transition-none"
          style={{ width: `${pct}%`, transitionTimingFunction: 'cubic-bezier(.23,1,.32,1)' }}
        />
      </div>
    );
  }
  if (isRunning) {
    // Indeterminate shimmer when running but total unknown
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/50 motion-reduce:animate-none" />
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
  return <p className="text-xs text-muted-foreground">Elapsed: {elapsed}</p>;
}

function RecentRunsTable({ runs }: { runs: readonly FpImportRunSummary[] }) {
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
        <thead className="border-b bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Phase</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium tabular-nums">Fetched</th>
            <th className="px-3 py-2 text-left font-medium tabular-nums">Created</th>
            <th className="px-3 py-2 text-left font-medium tabular-nums">Errors</th>
            <th className="px-3 py-2 text-left font-medium">Started</th>
            <th className="px-3 py-2 text-left font-medium tabular-nums">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((run) => {
            const counts = run.counts as FpRunCounts;
            return (
              <tr key={run.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 capitalize">{run.phase}</td>
                <td className="px-3 py-2">
                  <StatusChip status={run.status} />
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
  // Cast at the boundary: FpImportRun.counts is Record<string,unknown> but
  // presenter functions expect FpImportRunSummary (with typed FpRunCounts).
  const { runs: rawRuns, isLoading, error, refresh, isPolling } = useFpImportStatus();
  const runs = rawRuns as readonly FpImportRunSummary[];

  const latestPerPhase = latestRunPerPhase(runs);

  if (isLoading && runs.length === 0) {
    return (
      <PageShell>
        <PageHeader title="FieldPulse Import" subtitle="Live import progress by phase" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {PIPELINE_ORDER.map((phase) => (
            <div
              key={phase}
              className="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
            />
          ))}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="FieldPulse Import"
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
        {PIPELINE_ORDER.map((phase) => {
          const run = latestPerPhase[phase];
          const counts = (run?.counts ?? {}) as FpRunCounts;
          const pct = run ? progressPct(counts) : null;
          const isRunning = run?.status === 'running';

          return (
            <div key={phase} className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold capitalize">{phase}</h2>
                <StatusChip status={run?.status} />
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
            </div>
          );
        })}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Recent Runs
        </h2>
        <RecentRunsTable runs={runs} />
      </div>
    </PageShell>
  );
}
