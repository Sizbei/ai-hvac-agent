'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MonthCalendar } from '@/lib/admin/types';

interface UseMonthCalendarResult {
  readonly month: MonthCalendar | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Fetches and polls the MONTH-view calendar for a business-tz date (any day in
 * the target month). Mirrors useSchedulingCalendar but hits ?view=month and is
 * typed to the lightweight MonthCalendar payload (job chips bucketed by day, no
 * lanes). Refetches when `date` changes; polls every 30s; skips in-flight
 * requests and ignores responses after unmount.
 */
export function useMonthCalendar(date: string): UseMonthCalendarResult {
  const [month, setMonth] = useState<MonthCalendar | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchMonth = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const url = `/api/admin/calendar?date=${encodeURIComponent(
        date,
      )}&view=month`;
      const res = await fetch(url);
      if (!isMountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load calendar' },
        }));
        if (isMountedRef.current) {
          setError(body?.error?.message ?? 'Failed to load calendar');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: MonthCalendar;
      };

      if (isMountedRef.current && body.success) {
        setMonth(body.data);
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
    // Clear the previous month so the grid shows its skeleton instead of stale
    // cells while the new month loads.
    setMonth(null);
    void fetchMonth().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });

    const intervalId = setInterval(() => {
      void fetchMonth();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchMonth]);

  return { month, isLoading, error, refetch: fetchMonth };
}
