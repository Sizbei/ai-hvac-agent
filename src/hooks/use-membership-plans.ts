'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface MembershipPlan {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceCents: number;
  readonly billingPeriod: string;
  readonly visitsPerYear: number;
  readonly active: boolean;
}

interface UseMembershipPlansResult {
  readonly plans: readonly MembershipPlan[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/** Loads the org's membership plans on mount; refetches after mutations. */
export function useMembershipPlans(): UseMembershipPlansResult {
  const [plans, setPlans] = useState<readonly MembershipPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await fetch('/api/admin/membership-plans');
      if (!res.ok) {
        setError('Failed to load membership plans');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { plans: MembershipPlan[] };
      };
      if (body.success) setPlans(body.data.plans);
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

  return { plans, isLoading, error, refetch: fetchAll };
}
