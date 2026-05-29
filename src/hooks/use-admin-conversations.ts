'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConversationSummary } from '@/lib/admin/conversation-types';

interface UseAdminConversationsOptions {
  readonly status?: string;
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

interface UseAdminConversationsResult {
  readonly conversations: readonly ConversationSummary[];
  readonly total: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Custom hook for fetching and polling the admin conversation list.
 * Polls every 10 seconds, skipping in-flight requests.
 */
export function useAdminConversations(
  options: UseAdminConversationsOptions = {},
): UseAdminConversationsResult {
  const { status, search, page = 1, limit = 20 } = options;

  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchConversations = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const url = `/api/admin/conversations?${params.toString()}`;
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch conversations' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch conversations');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: {
          conversations: ConversationSummary[];
          total: number;
          page: number;
          limit: number;
        };
      };

      if (body.success) {
        setConversations(body.data.conversations);
        setTotal(body.data.total);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, [status, search, page, limit]);

  // Fetch on mount and when options change
  useEffect(() => {
    setIsLoading(true);
    fetchConversations().finally(() => setIsLoading(false));
  }, [fetchConversations]);

  // Poll every 10 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchConversations();
    }, 10_000);

    return () => clearInterval(intervalId);
  }, [fetchConversations]);

  return { conversations, total, isLoading, error, refetch: fetchConversations };
}
