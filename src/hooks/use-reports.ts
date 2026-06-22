'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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

interface UseReportsResult {
  readonly report: SalesReport | null;
  readonly leadSourceBreakdown: LeadSourceRow[];
  readonly locationBreakdown: LocationBreakdownRow[];
  readonly technicianScorecards: TechnicianScorecardRow[];
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
  const [leadSourceBreakdown, setLeadSourceBreakdown] = useState<LeadSourceRow[]>([]);
  const [locationBreakdown, setLocationBreakdown] = useState<LocationBreakdownRow[]>([]);
  const [technicianScorecards, setTechnicianScorecards] = useState<TechnicianScorecardRow[]>([]);
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
        data: {
          report: SalesReport;
          leadSourceBreakdown?: LeadSourceRow[];
          locationBreakdown?: LocationBreakdownRow[];
          technicianScorecards?: TechnicianScorecardRow[];
        };
      };
      if (body.success) {
        setReport(body.data.report);
        setLeadSourceBreakdown(body.data.leadSourceBreakdown ?? []);
        setLocationBreakdown(body.data.locationBreakdown ?? []);
        setTechnicianScorecards(body.data.technicianScorecards ?? []);
      }
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

  return {
    report,
    leadSourceBreakdown,
    locationBreakdown,
    technicianScorecards,
    isLoading,
    error,
    refetch: fetchReport,
  };
}
