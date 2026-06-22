'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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

interface UseReviewsResult {
  readonly reviews: ReviewRow[];
  readonly stats: ReviewStats | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/** Loads the org's review requests + aggregate stats. No polling — read at
 *  human pace. Modeled on use-reports. */
export function useReviews(): UseReviewsResult {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchReviews = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/reviews');
      const body = (await res.json()) as {
        success: boolean;
        data?: { reviews: ReviewRow[]; stats: ReviewStats };
        error?: { message: string };
      };
      if (res.ok && body.success && body.data) {
        setReviews(body.data.reviews);
        setStats(body.data.stats);
      } else {
        setError(body.error?.message ?? 'Could not load reviews.');
      }
    } catch {
      setError('Could not connect to the server.');
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchReviews();
  }, [fetchReviews]);

  return { reviews, stats, isLoading, error, refetch: fetchReviews };
}
