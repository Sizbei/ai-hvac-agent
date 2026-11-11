'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConversationSummary } from '@/lib/admin/conversation-types';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface UseAdminConversationsOptions {
  readonly status?: string;
  readonly channel?: string;
  readonly search?: string;
  /** Only conversations that need action (escalated, not handled). */
  readonly needsAction?: boolean;
  /** Include empty widget opens (no customer message, no request). */
  readonly includeEmpty?: boolean;
  readonly page?: number;
  readonly limit?: number;
  /** Background poll interval in ms. Defaults to 10s; callers that don't need
   * that cadence (e.g. the dashboard recent-conversations card) can pass a
   * larger value to reduce load. */
  readonly intervalMs?: number;
}

interface UseAdminConversationsResult {
  readonly conversations: readonly ConversationSummary[];
  readonly total: number;
  /** Org-wide count of conversations that need action. */
  readonly needsActionCount: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

interface ConversationsPayload {
  readonly conversations: readonly ConversationSummary[];
  readonly total: number;
  readonly needsActionCount: number;
}

/** Human copy for a failed list load — never the server's error string. */
export const CONVERSATIONS_LOAD_ERROR = "Couldn't load conversations. Please try again.";

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
  const {
    status,
    channel,
    search,
    needsAction = false,
    includeEmpty = false,
    page = 1,
    limit = 20,
    intervalMs = 10_000,
  } = options;

  const key = `conversations:${status ?? ''}:${channel ?? ''}:${search ?? ''}:${needsAction ? 1 : 0}:${includeEmpty ? 1 : 0}:${page}:${limit}`;

  const [conversations, setConversations] = useState<readonly ConversationSummary[]>(
    () => conversationsCache.get(key)?.data.conversations ?? [],
  );
  const [total, setTotal] = useState(() => conversationsCache.get(key)?.data.total ?? 0);
  const [needsActionCount, setNeedsActionCount] = useState(
    () => conversationsCache.get(key)?.data.needsActionCount ?? 0,
  );
  const [isLoading, setIsLoading] = useState(() => conversationsCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  // Latest-wins: each call increments this counter; a response only applies if
  // its captured run id still matches the current value when it resolves.
  const runRef = useRef(0);
  // Equality guard: skip setState when poll returns identical data (avoids re-rendering
  // the full list on every 10s tick when nothing changed). Full JSON serialization so
  // any in-place field change (e.g. status update on an existing row) still triggers.
  const prevDataRef = useRef<string | null>(null);

  const fetchConversations = useCallback(async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
    if (bust) conversationsCache.invalidate(key);

    const run = ++runRef.current;

    const cached = conversationsCache.get(key);
    const hasCachedData = cached !== null;
    // A failed refresh over an out-of-date entry must say so, not pass as current.
    const hasFreshData = conversationsCache.isFresh(key);
    if (hasCachedData) {
      setConversations(cached.data.conversations);
      setTotal(cached.data.total);
      setNeedsActionCount(cached.data.needsActionCount);
    } else {
      // Only show the loading skeleton when there's nothing to display yet
      setIsLoading(true);
    }

    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);
      if (search) params.set('search', search);
      if (needsAction) params.set('needsAction', '1');
      if (includeEmpty) params.set('includeEmpty', '1');
      params.set('page', String(page));
      params.set('limit', String(limit));

      const url = `/api/admin/conversations?${params.toString()}`;
      const res = await adminFetch(url);

      if (run !== runRef.current) return;
      if (!res.ok) {
        if (run === runRef.current && !hasFreshData) {
          setError(CONVERSATIONS_LOAD_ERROR);
        }
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: {
          conversations: ConversationSummary[];
          total: number;
          needsActionCount: number;
          page: number;
          limit: number;
        };
      };

      if (run === runRef.current && body.success) {
        const next = JSON.stringify(body.data.conversations);
        if (next !== prevDataRef.current) {
          prevDataRef.current = next;
          setConversations(body.data.conversations);
          setTotal(body.data.total);
        }
        setNeedsActionCount(body.data.needsActionCount ?? 0);
        setError(null);
        conversationsCache.set(key, {
          conversations: body.data.conversations,
          total: body.data.total,
          needsActionCount: body.data.needsActionCount ?? 0,
        });
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      if (run === runRef.current && !hasFreshData) {
        setError(CONVERSATIONS_LOAD_ERROR);
      }
    } finally {
      if (run === runRef.current) setIsLoading(false);
    }
  }, [key, status, channel, search, needsAction, includeEmpty, page, limit]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  // Background refresh (never shows skeleton when data exists). Interval is
  // caller-tunable (defaults to 10s).
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchConversations();
    }, intervalMs);

    return () => clearInterval(intervalId);
  }, [fetchConversations, intervalMs]);

  const refetch = useCallback(() => fetchConversations({ bust: true }), [fetchConversations]);

  return { conversations, total, needsActionCount, isLoading, error, refetch };
}
