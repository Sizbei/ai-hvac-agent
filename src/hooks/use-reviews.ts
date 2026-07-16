'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export interface ReviewRow {
  readonly id: string;
  readonly serviceRequestId: string;
  readonly status: 'pending' | 'sent' | 'responded';
  readonly rating: number | null;
  readonly publicClicked: boolean;
  readonly sentAt: string | null;
  readonly respondedAt: string | null;
  readonly createdAt: string;
}

export interface ReviewStats {
  readonly count: number;
  readonly avgRating: number | null;
  readonly responded: number;
}

export interface UseReviewsParams {
  readonly page?: number;
  readonly limit?: number;
}

interface UseReviewsResult {
  readonly reviews: ReviewRow[];
  readonly total: number;
  readonly stats: ReviewStats | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/** Loads the org's review requests + aggregate stats. No polling — read at
 *  human pace. Modeled on use-reports. */
export function useReviews(params: UseReviewsParams = {}): UseReviewsResult {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic run counter (latest-wins): a rapid page/param change supersedes an
  // in-flight fetch instead of being dropped, and a stale response is discarded.
  const runRef = useRef(0);
  const { page = 1, limit = 50 } = params;

  const fetchReviews = useCallback(async (): Promise<void> => {
    const run = ++runRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      const res = await adminFetch(`/api/admin/reviews?${qs.toString()}`);
      const body = (await res.json()) as {
        success: boolean;
        data?: { reviews: ReviewRow[]; total: number; stats: ReviewStats };
        error?: { message: string };
      };
      if (run !== runRef.current) return; // superseded by a newer fetch
      if (res.ok && body.success && body.data) {
        setReviews(body.data.reviews);
        setTotal(body.data.total);
        setStats(body.data.stats);
      } else {
        setError(body.error?.message ?? 'Could not load reviews.');
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return; // redirecting to login
      if (run === runRef.current) setError('Could not connect to the server.');
    } finally {
      if (run === runRef.current) setIsLoading(false);
    }
  }, [page, limit]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchReviews();
  }, [fetchReviews]);

  return { reviews, total, stats, isLoading, error, refetch: fetchReviews };
}
