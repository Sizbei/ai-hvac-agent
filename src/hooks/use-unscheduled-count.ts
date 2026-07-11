'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';

interface UseUnscheduledCountResult {
  readonly count: number;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60_000;

// The badge mounts on EVERY admin page navigation — seed from the last known
// value so each page doesn't flash 0 and fire its own request; a fresh cache
// hit skips the network entirely and the 60s poll keeps it current.
const countCache = createSwrCache<number>(POLL_INTERVAL_MS);
const CACHE_KEY = 'unscheduled-count';

/**
 * Polls the count of unscheduled jobs (no technician and/or no arrival window)
 * for the admin-nav notification badge. Polls once a minute — the badge is an
 * ambient indicator, not a live grid, so a slower cadence than the calendar's
 * keeps it cheap. Ignores responses that resolve after unmount.
 */
export function useUnscheduledCount(): UseUnscheduledCountResult {
  const [count, setCount] = useState(() => countCache.get(CACHE_KEY)?.data ?? 0);
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
        countCache.set(CACHE_KEY, body.data.count);
      }
    } catch {
      // Ambient badge: swallow transient errors and keep the last known count.
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    // Fresh cache hit → skip the immediate network fetch; the poll still runs.
    if (countCache.get(CACHE_KEY) === null) {
      void fetchCount();
    }
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
