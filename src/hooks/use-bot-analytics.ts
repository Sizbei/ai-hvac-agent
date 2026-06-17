'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { BotAnalytics } from '@/lib/admin/bot-analytics-queries';

interface UseBotAnalyticsResult {
  readonly data: BotAnalytics | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Fetches the /api/admin/bot-analytics payload (Step 10 intent/outcome
 * analytics). One-shot fetch; on failure the previously loaded data is retained.
 */
export function useBotAnalytics(): UseBotAnalyticsResult {
  const [data, setData] = useState<BotAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchAnalytics = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/bot-analytics');
      if (!isMountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to load bot analytics' },
        }));
        if (isMountedRef.current) {
          setError(body?.error?.message ?? 'Failed to load bot analytics');
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: BotAnalytics;
      };

      if (isMountedRef.current && body.success) {
        setData(body.data);
        setError(null);
      }
    } catch {
      if (isMountedRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    setIsLoading(true);
    void fetchAnalytics().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });

    return () => {
      isMountedRef.current = false;
    };
  }, [fetchAnalytics]);

  return { data, isLoading, error, refetch: fetchAnalytics };
}
