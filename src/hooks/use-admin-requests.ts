'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AdminRequest, RequestSortKey } from '@/lib/admin/types';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface UseAdminRequestsOptions {
  readonly status?: string;
  /** Reference-number search term (prefix match). */
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
  readonly urgency?: string;
  readonly assignedTo?: string;
  readonly isAfterHours?: boolean;
  /** Server-side sort order. */
  readonly sort?: RequestSortKey;
}

interface UseAdminRequestsResult {
  readonly requests: readonly AdminRequest[];
  readonly total: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

interface RequestsPayload {
  readonly requests: readonly AdminRequest[];
  readonly total: number;
}

const requestsCache = createSwrCache<RequestsPayload>(30_000); // 30s TTL

/**
 * Custom hook for fetching and polling the admin service request list.
 * Polls every 10 seconds, skipping in-flight requests.
 * Uses a module-level SWR cache so filter/page changes keep existing rows
 * visible (dimmed) while the next page loads — no skeleton flash.
 */
export function useAdminRequests(
  options: UseAdminRequestsOptions = {},
): UseAdminRequestsResult {
  const { status, search, page = 1, limit = 50, urgency, assignedTo, isAfterHours, sort } = options;

  const key = `requests:${status ?? ''}:${search ?? ''}:${page}:${limit}:${urgency ?? ''}:${assignedTo ?? ''}:${isAfterHours ? '1' : '0'}:${sort ?? ''}`;

  const [requests, setRequests] = useState<readonly AdminRequest[]>(
    () => requestsCache.get(key)?.data.requests ?? [],
  );
  const [total, setTotal] = useState(() => requestsCache.get(key)?.data.total ?? 0);
  const [isLoading, setIsLoading] = useState(() => requestsCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  // Latest-wins run counter: a filter change mid-poll supersedes the in-flight
  // fetch instead of being dropped (the old isFetchingRef drop-guard stranded it).
  const runRef = useRef(0);

  const fetchRequests = useCallback(async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
    if (bust) requestsCache.invalidate(key);

    const run = ++runRef.current;

    const cached = requestsCache.get(key);
    const hasCachedData = cached !== null;
    if (hasCachedData) {
      setRequests(cached.data.requests);
      setTotal(cached.data.total);
    } else {
      setIsLoading(true);
    }

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      params.set('page', String(page));
      params.set('limit', String(limit));
      if (urgency) params.set('urgency', urgency);
      if (assignedTo) params.set('assignedTo', assignedTo);
      if (isAfterHours) params.set('isAfterHours', 'true');
      if (sort) params.set('sort', sort);

      const url = `/api/admin/requests?${params.toString()}`;
      const res = await adminFetch(url);
      if (run !== runRef.current) return; // superseded by a newer fetch

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch requests' },
        }));
        if (run === runRef.current && !hasCachedData) {
          setError(body?.error?.message ?? 'Failed to fetch requests');
        }
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

      if (run !== runRef.current) return;
      if (body.success) {
        setRequests(body.data.requests);
        setTotal(body.data.total);
        setError(null);
        requestsCache.set(key, {
          requests: body.data.requests,
          total: body.data.total,
        });
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (run === runRef.current && !hasCachedData) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      if (run === runRef.current) setIsLoading(false);
    }
  }, [key, status, search, page, limit, urgency, assignedTo, isAfterHours, sort]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  // Poll every 10 seconds (background refresh — never sets isLoading when data exists)
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchRequests();
    }, 10_000);

    return () => clearInterval(intervalId);
  }, [fetchRequests]);

  const refetch = useCallback(() => fetchRequests({ bust: true }), [fetchRequests]);

  return { requests, total, isLoading, error, refetch };
}
