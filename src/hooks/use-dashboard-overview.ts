'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';
import type { DashboardOverview } from '@/lib/admin/types';

interface UseDashboardOverviewResult {
  readonly overview: DashboardOverview | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

// Navigation-bounce cache: returning to the dashboard within the poll window
// paints the last payload instantly (stale-while-revalidate) instead of a
// skeleton + a full round trip. The 30s poll keeps it current while mounted.
const overviewCache = createSwrCache<DashboardOverview>(POLL_INTERVAL_MS);
const CACHE_KEY = 'dashboard-overview';

/**
 * Fetches and polls the /admin overview payload (KPIs + dashboard lists).
 * Polls every 30s, skipping in-flight requests. On poll failure the previously
 * loaded data is retained so the dashboard never flashes empty.
 */
export function useDashboardOverview(): UseDashboardOverviewResult {
  const [overview, setOverview] = useState<DashboardOverview | null>(
    () => overviewCache.get(CACHE_KEY)?.data ?? null,
  );
  const [isLoading, setIsLoading] = useState(
    () => overviewCache.get(CACHE_KEY) === null,
  );
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  // Skip any state update that resolves after the component has unmounted so we
  // never set state on a torn-down component (e.g. fast navigation away).
  const isMountedRef = useRef(true);

  const fetchOverview = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/overview');
      if (!isMountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load dashboard' },
        }));
        if (isMountedRef.current) {
          setError(body?.error?.message ?? 'Failed to load dashboard');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: DashboardOverview;
      };

      if (isMountedRef.current && body.success) {
        setOverview(body.data);
        overviewCache.set(CACHE_KEY, body.data);
        setError(null);
      }
    } catch {
      if (isMountedRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    // With a cached payload already painted, revalidate silently (no skeleton).
    if (overviewCache.get(CACHE_KEY) === null) setIsLoading(true);
    void fetchOverview().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });

    const intervalId = setInterval(() => {
      void fetchOverview();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchOverview]);

  return { overview, isLoading, error, refetch: fetchOverview };
}
