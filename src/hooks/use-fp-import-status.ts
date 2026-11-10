'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { isStaleRun } from '@/components/admin/fp-import/import-status-model';

export interface FpImportRun {
  readonly id: string;
  readonly phase: string;
  readonly status: string;
  readonly counts: Record<string, unknown>;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface UseFpImportStatusResult {
  readonly runs: readonly FpImportRun[];
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Manually re-fetch when polling is idle (no active run). */
  readonly refresh: () => void;
  /** True while at least one run has status 'running'. When false, polling stops. */
  readonly isPolling: boolean;
  /**
   * `Date.now()` captured at the last successful fetch. Callers derive
   * staleness (`isStaleRun(run, asOfMs)`) from this instead of calling
   * `Date.now()` directly during render, which React's purity rules forbid.
   * `0` until the first fetch resolves (unused before then — the page shows
   * a loading skeleton, not the phase grid, while this is `0`).
   */
  readonly asOfMs: number;
}

/**
 * Returns the next poll delay in ms, or null when polling should stop.
 * A "running" row that has gone stale (Rfieldpulse-import-2) no longer
 * counts as active — otherwise a killed import would poll forever and the
 * Refresh button would stay permanently hidden (`isPolling` never turns
 * false). Exported as a pure function so it can be unit-tested without a DOM.
 */
export function nextPollDelay(
  runs: readonly FpImportRun[],
  nowMs: number = Date.now(),
): number | null {
  const hasActiveRunning = runs.some(
    (r) => r.status === 'running' && !isStaleRun(r, nowMs),
  );
  return hasActiveRunning ? 2500 : null;
}

export function useFpImportStatus(): UseFpImportStatusResult {
  const [runs, setRuns] = useState<readonly FpImportRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [asOfMs, setAsOfMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Used to trigger a manual refresh from outside the polling loop.
  const [refreshToken, setRefreshToken] = useState(0);

  const fetchStatus = useCallback(async (): Promise<readonly FpImportRun[]> => {
    try {
      const res = await fetch('/api/admin/integrations/fieldpulse/import-status');
      if (!res.ok) {
        setError('Couldn’t load import status. Please try again.');
        return [];
      }
      const body = (await res.json()) as { success: boolean; data: { runs: FpImportRun[] } };
      if (body.success) {
        setRuns(body.data.runs);
        setAsOfMs(Date.now());
        setError(null);
        return body.data.runs;
      }
      return [];
    } catch {
      setError('Could not connect to server. Please try again.');
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const fetched = await fetchStatus();
      if (cancelled) return;
      setIsLoading(false);
      const delay = nextPollDelay(fetched);
      if (delay !== null) {
        setIsPolling(true);
        timerRef.current = setTimeout(tick, delay);
      } else {
        // No active run — stop polling until a manual refresh.
        setIsPolling(false);
      }
    }

    setIsLoading(true);
    void tick();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // refreshToken intentionally re-runs the effect for manual refresh.
  }, [fetchStatus, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { runs, isLoading, error, refresh, isPolling, asOfMs };
}
