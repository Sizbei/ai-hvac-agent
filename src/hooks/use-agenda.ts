'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgendaBooking, AgendaPage } from '@/lib/admin/types';

interface UseAgendaResult {
  readonly bookings: readonly AgendaBooking[];
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
  readonly loadOlder: () => void;
  readonly refetch: () => void;
}

async function fetchPage(cursor: string | null): Promise<AgendaPage> {
  const url = cursor
    ? `/api/admin/agenda?cursor=${encodeURIComponent(cursor)}`
    : `/api/admin/agenda`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? 'Failed to load agenda');
  }
  const body = (await res.json()) as { success: boolean; data: AgendaPage };
  return body.data;
}

/**
 * Loads the chronological booking feed. On mount (when `enabled`) it fetches the
 * first page — the rolling 90-day + upcoming window — and `loadOlder` appends the
 * next older page via the cursor. No polling: agenda is history, not a live board.
 */
export function useAgenda(enabled = true): UseAgendaResult {
  const [bookings, setBookings] = useState<readonly AgendaBooking[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const loadFirst = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoading(true);
    try {
      const page = await fetchPage(null);
      if (!isMountedRef.current) return;
      setBookings(page.bookings);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setError(null);
    } catch (e) {
      if (isMountedRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load agenda');
      }
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (inFlightRef.current || !cursor) return;
    inFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (!isMountedRef.current) return;
      // Keyset pagination doesn't duplicate, but de-dupe on id anyway as a cheap
      // guard against a double-fire appending the same page twice.
      setBookings((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        return [...prev, ...page.bookings.filter((b) => !seen.has(b.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setError(null);
    } catch (e) {
      if (isMountedRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load older bookings');
      }
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setIsLoadingMore(false);
    }
  }, [cursor]);

  useEffect(() => {
    if (!enabled) return;
    isMountedRef.current = true;
    void loadFirst();
    return () => {
      isMountedRef.current = false;
    };
  }, [enabled, loadFirst]);

  return {
    bookings,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    loadOlder,
    refetch: loadFirst,
  };
}
