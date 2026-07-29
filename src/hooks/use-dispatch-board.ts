'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DispatchBoard } from '@/lib/admin/types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export interface DispatchException {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly autoDispatchOutcome: string;
  readonly createdAt: string;
}

export type DispatchBoardWithExceptions = DispatchBoard & {
  readonly exceptions: readonly DispatchException[];
};

interface UseDispatchBoardResult {
  readonly board: DispatchBoardWithExceptions | null;
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
  const [board, setBoard] = useState<DispatchBoardWithExceptions | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  const isMountedRef = useRef(true);
  // Equality guard: skip the data setState when a poll returns an identical
  // payload (avoids re-rendering the whole board on every 30s tick when nothing
  // changed). Full JSON serialization so any nested change still applies. Reset
  // on date change so a new day always paints (see the effect below).
  const prevDataRef = useRef<string | null>(null);

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
        data: DispatchBoardWithExceptions;
      };

      if (isMountedRef.current && run === runRef.current && body.success) {
        const next = JSON.stringify(body.data);
        if (next !== prevDataRef.current) {
          prevDataRef.current = next;
          setBoard(body.data);
        }
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
    // Reset the equality guard too, so the new day's data always repaints even
    // if it happens to serialize identically to the day we just cleared.
    prevDataRef.current = null;
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
