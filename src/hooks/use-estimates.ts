'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface EstimateListItem {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly signedAt: string | null;
  readonly syncedSource: 'fieldpulse' | null;
  readonly fieldpulseStatusName: string | null;
  readonly title: string | null;
  readonly fieldpulseData: Record<string, unknown> | null;
}

export interface UseEstimatesParams {
  readonly page?: number;
  readonly limit?: number;
}

interface UseEstimatesResult {
  readonly estimates: readonly EstimateListItem[];
  readonly total: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's estimates on mount, refetches after mutations. No polling —
 * estimates change at human pace. Modeled on use-pricebook.
 */
export function useEstimates(params: UseEstimatesParams = {}): UseEstimatesResult {
  const [estimates, setEstimates] = useState<readonly EstimateListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);
  const { page = 1, limit = 50 } = params;

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      const res = await fetch(`/api/admin/estimates?${qs.toString()}`);
      if (!res.ok) {
        setError('Failed to load estimates');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { estimates: EstimateListItem[]; total: number };
      };
      if (body.success) {
        setEstimates(body.data.estimates);
        setTotal(body.data.total);
      }
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, [page, limit]);

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  return { estimates, total, isLoading, error, refetch: fetchAll };
}
