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

/**
 * The real FieldPulse import pipeline, in dependency order — mirrors `PHASES`
 * in `src/lib/integrations/fieldpulse/import/run-import.ts:75-169` (11
 * phases, not the 4 this page used to hardcode). This is the single source
 * of truth for both the phase-card grid (`page.tsx`) and `latestRunPerPhase`
 * below — do not hand-maintain a second copy of this list anywhere else in
 * the page surface (that duplication was the root cause of Gfieldpulse-import-1).
 */
export const PIPELINE_PHASES = [
  'technicians',
  'customers',
  'jobs',
  'invoices',
  'estimates',
  'payments',
  'assets',
  'comments',
  'locations',
  'items',
  'job-metrics',
] as const;

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

/**
 * A "running" row older than this is treated as abandoned, not active —
 * comfortably past the GitHub Actions nightly job's 150-minute timeout
 * (`.github/workflows/fp-nightly-sync.yml`). `run-import.ts` has no
 * SIGINT/SIGTERM handler, so a killed process leaves its row `status:
 * 'running'` forever; this threshold is how the UI tells "still actively
 * running" apart from "died hours ago" without ever writing to the DB.
 */
export const STALE_RUN_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * True only for a row still marked `running` whose `startedAt` is older than
 * `STALE_RUN_THRESHOLD_MS`. Pure — no I/O, no DB write; display-only per this
 * page's observability-only invariant (Rfieldpulse-import-2).
 */
export function isStaleRun(
  run: { readonly status: string; readonly startedAt: string },
  nowMs: number,
): boolean {
  if (run.status !== 'running') return false;
  const startedMs = new Date(run.startedAt).getTime();
  if (Number.isNaN(startedMs)) return false;
  return nowMs - startedMs > STALE_RUN_THRESHOLD_MS;
}
