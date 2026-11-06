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
  // Equality guard: skip the data setState when a poll returns an identical
  // payload (avoids re-rendering all lanes on every 30s tick when nothing
  // changed). Full JSON serialization so any nested change still applies. Reset
  // on range change so a new date/view always paints (see the effect below).
  const prevDataRef = useRef<string | null>(null);

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
        // Human copy, never the server's message.
        if (isMountedRef.current && run === runRef.current) {
          setError('Couldn’t load the calendar.');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: SchedulingCalendar;
      };

      if (isMountedRef.current && run === runRef.current && body.success) {
        const next = JSON.stringify(body.data);
        if (next !== prevDataRef.current) {
          prevDataRef.current = next;
          setCalendar(body.data);
        }
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current && run === runRef.current) {
        setError('Couldn’t load the calendar.');
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
    // Reset the equality guard so the new range's data always repaints even if
    // it serializes identically to the range we just cleared.
    prevDataRef.current = null;
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
