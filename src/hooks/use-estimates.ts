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
}

interface UseEstimatesResult {
  readonly estimates: readonly EstimateListItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's estimates on mount, refetches after mutations. No polling —
 * estimates change at human pace. Modeled on use-pricebook.
 */
export function useEstimates(): UseEstimatesResult {
  const [estimates, setEstimates] = useState<readonly EstimateListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/estimates');
      if (!res.ok) {
        setError('Failed to load estimates');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { estimates: EstimateListItem[] };
      };
      if (body.success) setEstimates(body.data.estimates);
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  return { estimates, isLoading, error, refetch: fetchAll };
}
