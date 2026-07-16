'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { SchedulingCalendar } from '@/lib/admin/types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export type CalendarView = 'day' | 'week' | 'month' | 'agenda';

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
 * `view` changes; polls every 30s otherwise. Uses latest-wins (monotonic run
 * counter) so a date/view change mid-flight supersedes the in-flight poll — the
 * stale response is discarded, not rendered. The unscheduled "to place" queue
 * rides along in the same payload (calendar.unscheduled).
 */
export function useSchedulingCalendar(
  date: string,
  view: CalendarView,
  /** When false, the hook does not fetch or poll (used when another view —
   * e.g. month — is active, so the inactive view doesn't fire requests). */
  enabled = true,
  /** When true, completed and cancelled jobs are included in the calendar
   * (rendered muted/non-draggable). Default false = today's behavior. */
  includeCompleted = false,
): UseSchedulingCalendarResult {
  const [calendar, setCalendar] = useState<SchedulingCalendar | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  const isMountedRef = useRef(true);

  const fetchCalendar = useCallback(async (): Promise<void> => {
    // `!enabled` MUST be checked before touching the run counter, so a disabled
    // hook never advances the sequence.
    if (!enabled) return;
    const run = ++runRef.current;

    try {
      const url =
        `/api/admin/calendar?date=${encodeURIComponent(date)}` +
        `&view=${encodeURIComponent(view)}` +
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
        data: SchedulingCalendar;
      };

      if (isMountedRef.current && run === runRef.current && body.success) {
        setCalendar(body.data);
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current && run === runRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    }
  }, [date, view, enabled, includeCompleted]);

  useEffect(() => {
    if (!enabled) return;
    // Set the mounted latch only on the active (enabled) path, AFTER the guard,
    // so a fetch started before `enabled` flipped to false can't setState on the
    // now-disabled hook when it resolves.
    isMountedRef.current = true;
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
