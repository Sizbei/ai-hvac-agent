'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DispatchBoard } from '@/lib/admin/types';

interface UseDispatchBoardResult {
  readonly board: DispatchBoard | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Fetches and polls the dispatch board for a given UTC day (ISO YYYY-MM-DD).
 * Refetches when `date` changes; polls every 30s otherwise. Skips in-flight
 * requests and ignores responses that resolve after unmount.
 */
export function useDispatchBoard(date: string): UseDispatchBoardResult {
  const [board, setBoard] = useState<DispatchBoard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchBoard = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch(`/api/admin/dispatch?date=${encodeURIComponent(date)}`);
      if (!isMountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load dispatch board' },
        }));
        if (isMountedRef.current) {
          setError(body?.error?.message ?? 'Failed to load dispatch board');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: DispatchBoard;
      };

      if (isMountedRef.current && body.success) {
        setBoard(body.data);
        setError(null);
      }
    } catch {
      if (isMountedRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      isFetchingRef.current = false;
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
