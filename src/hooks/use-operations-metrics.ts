'use client';

import { useState, useEffect, useCallback } from 'react';

export interface MetricTrend {
  readonly current: number | null;
  readonly previous: number | null;
}

export interface ArAging {
  readonly bucket0to30Cents: number;
  readonly bucket31to60Cents: number;
  readonly bucket60PlusCents: number;
  readonly totalOutstandingCents: number;
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
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's operations scorecard for the given range, refetching when the
 * range changes. No polling — an owner reads this at human pace. Modeled on
 * useReports.
 */
export function useOperationsMetrics(
  range: MetricsRange = {},
): UseOperationsMetricsResult {
  const [metrics, setMetrics] = useState<OperationsMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const { from, to } = range;

  const refetch = useCallback(async (): Promise<void> => {
    setReloadNonce((n) => n + 1);
  }, []);

  // Latest-wins: each range change starts its own request and marks any prior
  // in-flight request stale via the cleanup flag, so a slow earlier fetch can
  // never overwrite the newer range's data (a plain in-flight guard would drop
  // the NEWER request and strand the UI on stale numbers).
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();
        const res = await fetch(
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
        if (body.success) setMetrics(body.data);
        setError(null);
      } catch {
        if (active) setError('Could not connect to server. Please try again.');
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [from, to, reloadNonce]);

  return { metrics, isLoading, error, refetch };
}
