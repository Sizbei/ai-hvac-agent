'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MonthCalendar } from '@/lib/admin/types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

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
export function useMonthCalendar(
  date: string,
  /** When false, the hook does not fetch or poll (used when month view is not
   * the active view, so it doesn't fire requests in the background). */
  enabled = true,
  /** When true, completed and cancelled jobs are included in the calendar.
   * Default false = today's behavior. */
  includeCompleted = false,
): UseMonthCalendarResult {
  const [month, setMonth] = useState<MonthCalendar | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  const isMountedRef = useRef(true);
  // Equality guard: skip the data setState when a poll returns an identical
  // payload (avoids re-rendering the whole grid on every 30s tick when nothing
  // changed). Full JSON serialization so any nested change still applies. Reset
  // on month change so a new month always paints (see the effect below).
  const prevDataRef = useRef<string | null>(null);

  const fetchMonth = useCallback(async (): Promise<void> => {
    // `!enabled` MUST be checked before touching the run counter, so a disabled
    // hook never advances the sequence.
    if (!enabled) return;
    const run = ++runRef.current;

    try {
      const url =
        `/api/admin/calendar?date=${encodeURIComponent(date)}&view=month` +
        (includeCompleted ? '&includeCompleted=true' : '');
      const res = await adminFetch(url);
      if (!isMountedRef.current || run !== runRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load calendar' },
        }));
        if (isMountedRef.current && run === runRef.current) {
          setError(body?.error?.message ?? 'Failed to load calendar');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: MonthCalendar;
      };

      if (isMountedRef.current && run === runRef.current && body.success) {
        const next = JSON.stringify(body.data);
        if (next !== prevDataRef.current) {
          prevDataRef.current = next;
          setMonth(body.data);
        }
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current && run === runRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    }
  }, [date, enabled, includeCompleted]);

  useEffect(() => {
    if (!enabled) return;
    // Set the mounted latch only on the active (enabled) path, AFTER the guard,
    // so a fetch started before `enabled` flipped to false can't setState on the
    // now-disabled hook when it resolves.
    isMountedRef.current = true;
    setIsLoading(true);
    // Clear the previous month so the grid shows its skeleton instead of stale
    // cells while the new month loads.
    setMonth(null);
    // Reset the equality guard so the new month's data always repaints even if
    // it serializes identically to the month we just cleared.
    prevDataRef.current = null;
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
  }, [fetchMonth, enabled]);

  return { month, isLoading, error, refetch: fetchMonth };
}
