export interface FpRunCounts {
  fetched?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  total?: number | null;
  [key: string]: unknown;
}

export interface FpImportRunSummary {
  readonly id: string;
  readonly phase: string;
  readonly status: string;
  readonly counts: FpRunCounts;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export type RunTone = 'info' | 'positive' | 'destructive' | 'muted';

const PIPELINE_PHASES = ['technicians', 'customers', 'jobs', 'invoices'] as const;

export function latestRunPerPhase(
  runs: readonly FpImportRunSummary[],
): Partial<Record<string, FpImportRunSummary>> {
  const result: Partial<Record<string, FpImportRunSummary>> = {};

  for (const phase of PIPELINE_PHASES) {
    const phaseRuns = runs.filter((r) => r.phase === phase);
    if (phaseRuns.length === 0) continue;
    result[phase] = phaseRuns.reduce((latest, run) =>
      run.startedAt > latest.startedAt ? run : latest,
    );
  }

  return result;
}

export function progressPct(counts: FpRunCounts): number | null {
  if (counts.total == null || counts.total === 0) return null;

  const processed =
    (counts.created ?? 0) +
    (counts.updated ?? 0) +
    (counts.skipped ?? 0) +
    (counts.errors ?? 0);

  return Math.min(100, Math.round((processed / counts.total) * 100));
}

export function formatElapsed(startedAt: string, endedAt?: string | null): string {
  const endMs = new Date(endedAt ?? new Date().toISOString()).getTime();
  const elapsed = endMs - new Date(startedAt).getTime();

  if (elapsed <= 0) return '0s';

  const totalSecs = Math.round(elapsed / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;

  const minutes = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${minutes}m ${secs}s`;
}

export function runTone(status: string): RunTone {
  switch (status) {
    case 'running':
      return 'info';
    case 'completed':
      return 'positive';
    case 'failed':
      return 'destructive';
    default:
      return 'muted';
  }
}
