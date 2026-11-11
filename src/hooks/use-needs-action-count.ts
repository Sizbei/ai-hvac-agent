'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';

const POLL_INTERVAL_MS = 30_000;
const countCache = createSwrCache<number>(POLL_INTERVAL_MS);
const CACHE_KEY = 'needs-action-count';

/** Fired by the inbox after Mark handled / Reopen / delete so the badge updates now. */
export const CONVERSATIONS_CHANGED_EVENT = 'conversations:changed';

export function notifyConversationsChanged(): void {
  countCache.invalidate(CACHE_KEY);
  window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT));
}

/**
 * Polls how many conversations need action, for the Conversations nav badge.
 * Seeds from the last known value so page navigations don't flash 0, and
 * re-reads when the inbox reports a triage change.
 */
export function useNeedsActionCount(): number {
  const [count, setCount] = useState(() => countCache.get(CACHE_KEY)?.data ?? 0);
  const isMountedRef = useRef(true);

  const fetchCount = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/conversations/needs-action-count');
      if (!isMountedRef.current || !res.ok) return;
      const body = (await res.json()) as { success: boolean; data: { count: number } };
      if (isMountedRef.current && body.success) {
        setCount(body.data.count);
        countCache.set(CACHE_KEY, body.data.count);
      }
    } catch {
      // Ambient badge: keep the last known count on a transient failure.
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    if (!countCache.isFresh(CACHE_KEY)) void fetchCount();
    const intervalId = setInterval(() => void fetchCount(), POLL_INTERVAL_MS);
    const onChanged = () => void fetchCount();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    };
  }, [fetchCount]);

  return count;
}
