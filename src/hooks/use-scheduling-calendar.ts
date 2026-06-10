'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { SchedulingCalendar } from '@/lib/admin/types';

export type CalendarView = 'day' | 'week' | 'month';

interface UseSchedulingCalendarResult {
  readonly calendar: SchedulingCalendar | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Fetches and polls the scheduling calendar for a business-tz date (YYYY-MM-DD)
 * in day or week view, mirroring use-dispatch-board. Refetches when `date` or
 * `view` changes; polls every 30s otherwise. Skips in-flight requests and
 * ignores responses that resolve after unmount. The unscheduled "to place"
 * queue rides along in the same payload (calendar.unscheduled).
 */
export function useSchedulingCalendar(
  date: string,
  view: CalendarView,
  /** When false, the hook does not fetch or poll (used when another view —
   * e.g. month — is active, so the inactive view doesn't fire requests). */
  enabled = true,
): UseSchedulingCalendarResult {
  const [calendar, setCalendar] = useState<SchedulingCalendar | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchCalendar = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const url = `/api/admin/calendar?date=${encodeURIComponent(
        date,
      )}&view=${encodeURIComponent(view)}`;
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
        data: SchedulingCalendar;
      };

      if (isMountedRef.current && body.success) {
        setCalendar(body.data);
        setError(null);
      }
    } catch {
      if (isMountedRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, [date, view]);

  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) return;
    setIsLoading(true);
    // Clear the previous range so the page shows its skeleton (guarded on
    // isLoading && !calendar) instead of stale lanes while the new range loads.
    setCalendar(null);
    void fetchCalendar().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });

    const intervalId = setInterval(() => {
      void fetchCalendar();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchCalendar, enabled]);

  return { calendar, isLoading, error, refetch: fetchCalendar };
}
