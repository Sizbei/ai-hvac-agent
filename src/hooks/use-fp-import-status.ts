'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

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
}

export function useFpImportStatus(): UseFpImportStatusResult {
  const [runs, setRuns] = useState<readonly FpImportRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async (): Promise<readonly FpImportRun[]> => {
    try {
      const res = await fetch('/api/admin/integrations/fieldpulse/import-status');
      if (!res.ok) {
        setError('Failed to load import status');
        return [];
      }
      const body = (await res.json()) as { success: boolean; data: { runs: FpImportRun[] } };
      if (body.success) {
        setRuns(body.data.runs);
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
      const hasRunning = fetched.some((r) => r.status === 'running');
      timerRef.current = setTimeout(tick, hasRunning ? 2500 : 10000);
    }

    setIsLoading(true);
    void tick();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [fetchStatus]);

  return { runs, isLoading, error };
}
