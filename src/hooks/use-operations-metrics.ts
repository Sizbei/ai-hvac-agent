'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export interface MetricTrend {
  readonly current: number | null;
  readonly previous: number | null;
}

export interface ArAging {
  readonly bucket0to30Cents: number;
  readonly bucket31to60Cents: number;
  readonly bucket60PlusCents: number;
  /** Native-only outstanding total (excludes synced FP/HCP). See totalOutstandingAllCents for the combined headline. */
  readonly nativeOutstandingCents: number;
}

/** Synced (FP/HCP) open receivables bucketed by days past the source system's
 * due date; `currentCents` = not yet due. Mirror of the server-side type. */
export interface SyncedArAging {
  readonly currentCents: number;
  readonly overdue1to30Cents: number;
  readonly overdue31to60Cents: number;
  readonly overdue60PlusCents: number;
  readonly totalOutstandingCents: number;
}

export interface OperationsMetrics {
  readonly rangeDays: number;
  readonly responseTimeSeconds: MetricTrend;
  readonly onSiteSeconds: number | null;
  readonly timeToPaidSeconds: MetricTrend;
  readonly arAging: ArAging;
  /** Total outstanding cents across FP-synced open invoices. */
  readonly syncedArTotalCents: number;
  /** Count of FP-synced open invoices contributing to syncedArTotalCents. */
  readonly syncedArCount: number;
  /** Due-date-based aging of the synced open receivables. */
  readonly syncedArAging: SyncedArAging;
  /** Native + synced AR combined — the headline number. Native-only lives in arAging.nativeOutstandingCents. */
  readonly totalOutstandingAllCents: number;
  readonly jobsBooked: MetricTrend;
  /** Count of FP-imported service requests in the current window. */
  readonly importedJobsCurrent: number;
  readonly firstResponseHumanSeconds: MetricTrend;
  readonly firstResponseSystemSeconds: number | null;
}

export interface MetricsRange {
  /** ISO date strings; omit both for the server default (last 30 days). */
  readonly from?: string;
  readonly to?: string;
}

interface UseOperationsMetricsResult {
  readonly metrics: OperationsMetrics | null;
  /** True only when there is no cached data for this range (first load). Cards show skeletons. */
  readonly isLoading: boolean;
  /** True while a background fetch is in flight with stale data already painted. */
  readonly isRevalidating: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const operationsCache = createSwrCache<OperationsMetrics>(60_000); // 60s TTL

/**
 * Cache key uses minute-truncated ISO strings so that switching back to a
 * previously-loaded preset within the same minute reuses the cached entry.
 * (The page derives `from`/`to` via `new Date()` — a fresh object each time
 * `days` changes — so raw ISO strings would differ by seconds and always miss.)
 */
function makeCacheKey(from: string | undefined, to: string | undefined): string {
  const truncMin = (iso: string) => iso.slice(0, 16); // 'YYYY-MM-DDTHH:MM'
  return `operations:${from ? truncMin(from) : ''}:${to ? truncMin(to) : ''}`;
}

/**
 * Loads the org's operations scorecard for the given range, refetching when the
 * range changes. No polling — an owner reads this at human pace.
 *
 * SWR behaviour: seeds state from the module-level cache so that switching
 * date presets keeps the previous KPI numbers painted (isLoading stays false)
 * while the fresh fetch runs in the background (isRevalidating=true).
 */
export function useOperationsMetrics(
  range: MetricsRange = {},
): UseOperationsMetricsResult {
  const { from, to } = range;
  const cacheKey = makeCacheKey(from, to);

  const [metrics, setMetrics] = useState<OperationsMetrics | null>(
    () => operationsCache.get(cacheKey)?.data ?? null,
  );
  // isLoading is only true when the cache is empty (no prior data to show).
  const [isLoading, setIsLoading] = useState(() => operationsCache.get(cacheKey) === null);
  // isRevalidating is true whenever a fetch is in flight, even with stale data painted.
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const isFetchingRef = useRef(false);
  // True once any successful fetch has completed — used to suppress the spinner
  // on absolute first load (skeletons are the loading signal then).
  const hasLoadedRef = useRef(operationsCache.get(cacheKey) !== null);

  const refetch = useCallback(async (): Promise<void> => {
    operationsCache.invalidate(cacheKey);
    setReloadNonce((n) => n + 1);
  }, [cacheKey]);

  useEffect(() => {
    // Seed state from cache on key change (e.g. preset switch). The setState
    // calls here are synchronous reads from an in-memory cache — not a render
    // loop. The set-state-in-effect warnings below are expected/intentional.
    const cached = operationsCache.get(cacheKey);
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMetrics(cached.data);
      setIsLoading(false);
    }
    // When there is no cache for the new range, keep whatever is currently
    // painted — do NOT clear state or set isLoading. The previous numbers
    // remain visible while the fresh fetch runs, which is the SWR contract.
    // isLoading is only ever true on first mount (set by the lazy initialiser).

    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    // Only show the spinner overlay when KPI cards are already painted with data.
    // On absolute first load (hasLoadedRef=false) the skeleton cards are the
    // loading signal — a spinner alongside them is redundant noise.
    if (hasLoadedRef.current) setIsRevalidating(true);

    let active = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();
        const res = await adminFetch(
          `/api/admin/operations-metrics${qs ? `?${qs}` : ''}`,
        );
        if (!active) return;
        if (!res.ok) {
          setError('Failed to load operations metrics');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: OperationsMetrics;
        };
        if (!active) return;
        if (body.success) {
          operationsCache.set(cacheKey, body.data);
          hasLoadedRef.current = true;
          setMetrics(body.data);
          setError(null);
        }
      } catch (err) {
        if (err instanceof AdminAuthRedirectError) return;
        if (active) setError('Could not connect to server. Please try again.');
      } finally {
        if (active) {
          setIsLoading(false);
          setIsRevalidating(false);
          isFetchingRef.current = false;
        }
      }
    })();
    return () => {
      active = false;
      isFetchingRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, reloadNonce]);

  return { metrics, isLoading, isRevalidating, error, refetch };
}
