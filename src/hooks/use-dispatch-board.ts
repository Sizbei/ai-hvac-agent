'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DispatchBoard } from '@/lib/admin/types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface UseDispatchBoardResult {
  readonly board: DispatchBoard | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Fetches and polls the dispatch board for a given UTC day (ISO YYYY-MM-DD).
 * Refetches when `date` changes; polls every 30s otherwise. Uses latest-wins
 * (monotonic run counter) so a date change mid-flight supersedes the in-flight
 * poll — the stale response is discarded, not rendered.
 */
export function useDispatchBoard(date: string): UseDispatchBoardResult {
  const [board, setBoard] = useState<DispatchBoard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  const isMountedRef = useRef(true);

  const fetchBoard = useCallback(async (): Promise<void> => {
    const run = ++runRef.current;

    try {
      const res = await adminFetch(`/api/admin/dispatch?date=${encodeURIComponent(date)}`);
      if (!isMountedRef.current || run !== runRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load dispatch board' },
        }));
        if (isMountedRef.current && run === runRef.current) {
          setError(body?.error?.message ?? 'Failed to load dispatch board');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: DispatchBoard;
      };

      if (isMountedRef.current && run === runRef.current && body.success) {
        setBoard(body.data);
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current && run === runRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    }
  }, [date]);

  useEffect(() => {
    isMountedRef.current = true;
    setIsLoading(true);
    // Clear the previous day's board so the page shows its skeleton (guarded on
    // `isLoading && !board`) instead of stale columns while the new day loads.
    setBoard(null);
    void fetchBoard().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });

    const intervalId = setInterval(() => {
      void fetchBoard();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchBoard]);

  return { board, isLoading, error, refetch: fetchBoard };
}
