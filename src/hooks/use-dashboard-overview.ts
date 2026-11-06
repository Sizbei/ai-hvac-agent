'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';
import type { DashboardOverview } from '@/lib/admin/types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

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
const LOAD_ERROR = "Couldn't load the dashboard.";

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
  // Equality guard: skip the data setState when a poll returns an identical
  // payload (avoids re-rendering the whole dashboard on every 30s tick when
  // nothing changed). Full JSON serialization so any nested change still applies.
  const prevDataRef = useRef<string | null>(null);

  const fetchOverview = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await adminFetch('/api/admin/overview');
      if (!isMountedRef.current) return;
      if (!res.ok) {
        // Human copy only — never the server's message.
        if (isMountedRef.current) setError(LOAD_ERROR);
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: DashboardOverview;
      };

      if (isMountedRef.current && body.success) {
        const next = JSON.stringify(body.data);
        if (next !== prevDataRef.current) {
          prevDataRef.current = next;
          setOverview(body.data);
        }
        overviewCache.set(CACHE_KEY, body.data);
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current) {
        setError(LOAD_ERROR);
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

  // Try again / after an assign: with nothing painted yet, show the skeletons
  // while it runs so the error state visibly gives way.
  const refetch = useCallback(async (): Promise<void> => {
    const showSkeleton = prevDataRef.current === null && overviewCache.get(CACHE_KEY) === null;
    if (showSkeleton) setIsLoading(true);
    await fetchOverview();
    if (showSkeleton && isMountedRef.current) setIsLoading(false);
  }, [fetchOverview]);

  return { overview, isLoading, error, refetch };
}
