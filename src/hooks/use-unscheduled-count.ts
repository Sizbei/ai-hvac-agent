'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseUnscheduledCountResult {
  readonly count: number;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls the count of unscheduled jobs (no technician and/or no arrival window)
 * for the admin-nav notification badge. Polls once a minute — the badge is an
 * ambient indicator, not a live grid, so a slower cadence than the calendar's
 * keeps it cheap. Ignores responses that resolve after unmount.
 */
export function useUnscheduledCount(): UseUnscheduledCountResult {
  const [count, setCount] = useState(0);
  const isMountedRef = useRef(true);

  const fetchCount = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/calendar/unscheduled-count');
      if (!isMountedRef.current || !res.ok) return;
      const body = (await res.json()) as {
        success: boolean;
        data: { count: number };
      };
      if (isMountedRef.current && body.success) {
        setCount(body.data.count);
      }
    } catch {
      // Ambient badge: swallow transient errors and keep the last known count.
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void fetchCount();
    const intervalId = setInterval(() => {
      void fetchCount();
    }, POLL_INTERVAL_MS);
    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchCount]);

  return { count, refetch: fetchCount };
}
