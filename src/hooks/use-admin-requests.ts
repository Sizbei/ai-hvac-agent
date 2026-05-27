'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AdminRequest } from '@/lib/admin/types';

interface UseAdminRequestsOptions {
  readonly status?: string;
  readonly page?: number;
  readonly limit?: number;
}

interface UseAdminRequestsResult {
  readonly requests: readonly AdminRequest[];
  readonly total: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Custom hook for fetching and polling the admin service request list.
 * Polls every 10 seconds, skipping in-flight requests.
 */
export function useAdminRequests(
  options: UseAdminRequestsOptions = {},
): UseAdminRequestsResult {
  const { status, page = 1, limit = 20 } = options;

  const [requests, setRequests] = useState<readonly AdminRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchRequests = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const url = `/api/admin/requests?${params.toString()}`;
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch requests' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch requests');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: {
          requests: AdminRequest[];
          total: number;
          page: number;
          limit: number;
        };
      };

      if (body.success) {
        setRequests(body.data.requests);
        setTotal(body.data.total);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, [status, page, limit]);

  // Fetch on mount and when options change
  useEffect(() => {
    setIsLoading(true);
    fetchRequests().finally(() => setIsLoading(false));
  }, [fetchRequests]);

  // Poll every 10 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchRequests();
    }, 10_000);

    return () => clearInterval(intervalId);
  }, [fetchRequests]);

  return { requests, total, isLoading, error, refetch: fetchRequests };
}
