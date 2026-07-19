'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConversationSummary } from '@/lib/admin/conversation-types';
import { createSwrCache } from '@/lib/admin/swr-cache';
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

interface ConversationsPayload {
  readonly conversations: readonly ConversationSummary[];
  readonly total: number;
}

const conversationsCache = createSwrCache<ConversationsPayload>(30_000); // 30s TTL

/**
 * Custom hook for fetching and polling the admin conversation list.
 * Polls every 10 seconds. Uses latest-wins (monotonic run counter) so a filter
 * change mid-flight supersedes the in-flight poll — the stale response is
 * discarded, not rendered.
 * Uses a module-level SWR cache: isLoading is only true when no data exists yet,
 * so background polls and filter-refetches keep existing rows visible (dimmed).
 */
export function useAdminConversations(
  options: UseAdminConversationsOptions = {},
): UseAdminConversationsResult {
  const { status, channel, search, page = 1, limit = 20 } = options;

  const key = `conversations:${status ?? ''}:${channel ?? ''}:${search ?? ''}:${page}:${limit}`;

  const [conversations, setConversations] = useState<readonly ConversationSummary[]>(
    () => conversationsCache.get(key)?.data.conversations ?? [],
  );
  const [total, setTotal] = useState(() => conversationsCache.get(key)?.data.total ?? 0);
  const [isLoading, setIsLoading] = useState(() => conversationsCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);

  const fetchConversations = useCallback(async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
    if (bust) conversationsCache.invalidate(key);

    const run = ++runRef.current;

    const cached = conversationsCache.get(key);
    const hasCachedData = cached !== null;
    if (hasCachedData) {
      setConversations(cached.data.conversations);
      setTotal(cached.data.total);
    } else {
      // Only show the loading skeleton when there's nothing to display yet
      setIsLoading(true);
    }

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);
      if (search) params.set('search', search);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const url = `/api/admin/conversations?${params.toString()}`;
      const res = await adminFetch(url);

      if (run !== runRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch conversations' },
        }));
        if (run === runRef.current && !hasCachedData) {
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

      if (run === runRef.current && body.success) {
        setConversations(body.data.conversations);
        setTotal(body.data.total);
        setError(null);
        conversationsCache.set(key, {
          conversations: body.data.conversations,
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
  }, [key, status, channel, search, page, limit]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  // Poll every 10 seconds (background refresh — never shows skeleton when data exists)
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchConversations();
    }, 10_000);

    return () => clearInterval(intervalId);
  }, [fetchConversations]);

  const refetch = useCallback(() => fetchConversations({ bust: true }), [fetchConversations]);

  return { conversations, total, isLoading, error, refetch };
}
