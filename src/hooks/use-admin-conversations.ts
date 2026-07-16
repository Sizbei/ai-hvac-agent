'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConversationSummary } from '@/lib/admin/conversation-types';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface UseAdminConversationsOptions {
  readonly status?: string;
  readonly channel?: string;
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
 * Polls every 10 seconds. Uses latest-wins (monotonic run counter) so a filter
 * change mid-flight supersedes the in-flight poll — the stale response is
 * discarded, not rendered. "Clear error only on success" is preserved.
 */
export function useAdminConversations(
  options: UseAdminConversationsOptions = {},
): UseAdminConversationsResult {
  const { status, channel, search, page = 1, limit = 20 } = options;

  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  const isMountedRef = useRef(true);

  const fetchConversations = useCallback(async (): Promise<void> => {
    const run = ++runRef.current;
    if (isMountedRef.current) setIsLoading(true);

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);
      if (search) params.set('search', search);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const url = `/api/admin/conversations?${params.toString()}`;
      const res = await adminFetch(url);

      if (!isMountedRef.current || run !== runRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch conversations' },
        }));
        if (isMountedRef.current && run === runRef.current) {
          setError(body?.error?.message ?? 'Failed to fetch conversations');
        }
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

      if (isMountedRef.current && run === runRef.current && body.success) {
        setConversations(body.data.conversations);
        setTotal(body.data.total);
        setError(null);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (isMountedRef.current && run === runRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      if (isMountedRef.current && run === runRef.current) setIsLoading(false);
    }
  }, [status, channel, search, page, limit]);

  // Fetch on mount and when options change
  useEffect(() => {
    isMountedRef.current = true;
    void fetchConversations();
    return () => {
      isMountedRef.current = false;
    };
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
