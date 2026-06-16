'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface SalesReport {
  readonly fromDate: string;
  readonly toDate: string;
  readonly grossCollectedCents: number;
  readonly refundedCents: number;
  readonly netCollectedCents: number;
  readonly outstandingArCents: number;
  readonly estimatesCreated: number;
  readonly estimatesSold: number;
  readonly estimatesOpen: number;
  readonly estimatesExpired: number;
  readonly closeRatePct: number;
  readonly invoicesCreated: number;
  readonly invoicesPaid: number;
}

export interface ReportRange {
  /** ISO date strings; omit both for the server default (last 30 days). */
  readonly from?: string;
  readonly to?: string;
}

interface UseReportsResult {
  readonly report: SalesReport | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's sales report for the given range, refetching when the range
 * changes. No polling — financial reports are read at human pace. Modeled on
 * use-pricebook.
 */
export function useReports(range: ReportRange = {}): UseReportsResult {
  const [report, setReport] = useState<SalesReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const { from, to } = range;

  const fetchReport = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const qs = params.toString();
      const res = await fetch(`/api/admin/reports${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        setError('Failed to load report');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { report: SalesReport };
      };
      if (body.success) setReport(body.data.report);
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, [from, to]);

  useEffect(() => {
    setIsLoading(true);
    fetchReport().finally(() => setIsLoading(false));
  }, [fetchReport]);

  return { report, isLoading, error, refetch: fetchReport };
}
