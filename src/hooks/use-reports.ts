'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export interface SalesReport {
  readonly fromDate: string;
  readonly toDate: string;
  readonly grossCollectedCents: number;
  readonly refundedCents: number;
  readonly netCollectedCents: number;
  readonly syncedCollectedCents: number;
  readonly outstandingArCents: number;
  readonly nativeArCents: number;
  readonly syncedArCents: number;
  readonly estimatesCreated: number;
  readonly estimatesSold: number;
  readonly estimatesOpen: number;
  readonly estimatesExpired: number;
  readonly closeRatePct: number;
  readonly invoicesCreated: number;
  readonly invoicesPaid: number;
}

export interface LeadSourceRow {
  readonly source: string;
  readonly leads: number;
  readonly booked: number;
  readonly revenueCents: number;
  readonly closeRatePct: number;
}

export interface LocationBreakdownRow {
  readonly locationId: string;
  readonly label: string;
  readonly jobs: number;
  readonly revenueCents: number;
  readonly avgRating: number | null;
}

export interface TechnicianScorecardRow {
  readonly technicianId: string;
  readonly name: string;
  readonly jobsAssigned: number;
  readonly jobsCompleted: number;
  readonly revenueCents: number;
  readonly laborHours: number | null;
  readonly avgRating: number | null;
}

export interface ReportRange {
  /** ISO date strings; omit both for the server default (last 30 days). */
  readonly from?: string;
  readonly to?: string;
}

interface ReportsPayload {
  readonly report: SalesReport;
  readonly leadSourceBreakdown: LeadSourceRow[];
  readonly locationBreakdown: LocationBreakdownRow[];
  readonly technicianScorecards: TechnicianScorecardRow[];
}

interface UseReportsResult {
  readonly report: SalesReport | null;
  readonly leadSourceBreakdown: LeadSourceRow[];
  readonly locationBreakdown: LocationBreakdownRow[];
  readonly technicianScorecards: TechnicianScorecardRow[];
  /** True only when there is no cached data for this range (first load). Cards show skeletons. */
  readonly isLoading: boolean;
  /** True while a background fetch is in flight with stale data already painted. */
  readonly isRevalidating: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const reportsCache = createSwrCache<ReportsPayload>(60_000); // 60s TTL

/**
 * Cache key uses minute-truncated ISO strings so that switching back to a
 * previously-loaded preset within the same minute reuses the cached entry.
 * (The page derives `from`/`to` via `new Date()` — a fresh object each time
 * `days` changes — so raw ISO strings would differ by seconds and always miss.)
 */
function makeCacheKey(from: string | undefined, to: string | undefined): string {
  const truncMin = (iso: string) => iso.slice(0, 16); // 'YYYY-MM-DDTHH:MM'
  return `reports:${from ? truncMin(from) : ''}:${to ? truncMin(to) : ''}`;
}

/**
 * Loads the org's sales report for the given range, refetching when the range
 * changes. No polling — financial reports are read at human pace.
 *
 * SWR behaviour: seeds state from the module-level cache so that switching
 * date presets keeps the previous KPI numbers painted (isLoading stays false)
 * while the fresh fetch runs in the background (isRevalidating=true).
 */
export function useReports(range: ReportRange = {}): UseReportsResult {
  const { from, to } = range;
  const cacheKey = makeCacheKey(from, to);

  const [report, setReport] = useState<SalesReport | null>(
    () => reportsCache.get(cacheKey)?.data.report ?? null,
  );
  const [leadSourceBreakdown, setLeadSourceBreakdown] = useState<LeadSourceRow[]>(
    () => reportsCache.get(cacheKey)?.data.leadSourceBreakdown ?? [],
  );
  const [locationBreakdown, setLocationBreakdown] = useState<LocationBreakdownRow[]>(
    () => reportsCache.get(cacheKey)?.data.locationBreakdown ?? [],
  );
  const [technicianScorecards, setTechnicianScorecards] = useState<TechnicianScorecardRow[]>(
    () => reportsCache.get(cacheKey)?.data.technicianScorecards ?? [],
  );
  // isLoading is only true when the cache is empty (no prior data to show).
  const [isLoading, setIsLoading] = useState(() => reportsCache.get(cacheKey) === null);
  // isRevalidating is true whenever a fetch is in flight, even with stale data painted.
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const isFetchingRef = useRef(false);
  // True once any successful fetch has completed — used to suppress the spinner
  // on absolute first load (skeletons are the loading signal then).
  const hasLoadedRef = useRef(reportsCache.get(cacheKey) !== null);

  const refetch = useCallback(async (): Promise<void> => {
    reportsCache.invalidate(cacheKey);
    setReloadNonce((n) => n + 1);
  }, [cacheKey]);

  useEffect(() => {
    // Seed state from cache on key change (e.g. preset switch). The setState
    // calls here are synchronous reads from an in-memory cache — not a render
    // loop. The set-state-in-effect warnings below are expected/intentional.
    const cached = reportsCache.get(cacheKey);
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReport(cached.data.report);
      setLeadSourceBreakdown(cached.data.leadSourceBreakdown);
      setLocationBreakdown(cached.data.locationBreakdown);
      setTechnicianScorecards(cached.data.technicianScorecards);
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
        const res = await adminFetch(`/api/admin/reports${qs ? `?${qs}` : ''}`);
        if (!active) return;
        if (!res.ok) {
          setError('Failed to load report');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: {
            report: SalesReport;
            leadSourceBreakdown?: LeadSourceRow[];
            locationBreakdown?: LocationBreakdownRow[];
            technicianScorecards?: TechnicianScorecardRow[];
          };
        };
        if (!active) return;
        if (body.success) {
          const payload: ReportsPayload = {
            report: body.data.report,
            leadSourceBreakdown: body.data.leadSourceBreakdown ?? [],
            locationBreakdown: body.data.locationBreakdown ?? [],
            technicianScorecards: body.data.technicianScorecards ?? [],
          };
          reportsCache.set(cacheKey, payload);
          hasLoadedRef.current = true;
          setReport(payload.report);
          setLeadSourceBreakdown(payload.leadSourceBreakdown);
          setLocationBreakdown(payload.locationBreakdown);
          setTechnicianScorecards(payload.technicianScorecards);
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

  return {
    report,
    leadSourceBreakdown,
    locationBreakdown,
    technicianScorecards,
    isLoading,
    isRevalidating,
    error,
    refetch,
  };
}
