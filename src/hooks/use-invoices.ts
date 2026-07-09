'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';

export interface InvoiceListItem {
  readonly id: string;
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: string;
  /** Issue date in the source system (FP/HCP mirrors); null for native
   * invoices — age falls back to createdAt. */
  readonly issuedAt: string | null;
  /** Source-system due date; drives overdue when present. */
  readonly dueDate: string | null;
  /** Which FSM this read-only invoice is mirrored from, or null when native. */
  readonly syncedSource: "fieldpulse" | "housecall" | null;
  readonly customerName: string | null;
  readonly lastReminderSentAt: string | null;
}

interface InvoicesPayload {
  readonly invoices: readonly InvoiceListItem[];
  readonly collectedThisMonthCents: number;
}

interface UseInvoicesResult {
  readonly invoices: readonly InvoiceListItem[];
  readonly collectedThisMonthCents: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
  readonly sendReminder: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  readonly voidInvoice: (id: string) => Promise<{ ok: boolean; reason?: string }>;
}

const invoicesCache = createSwrCache<InvoicesPayload>(60_000); // 60s TTL
const CACHE_KEY = 'invoices';

/**
 * Loads the org's invoices on mount, refetches after mutations. No polling —
 * invoices change at human pace. Modeled on use-estimates.
 */
export function useInvoices(): UseInvoicesResult {
  const [invoices, setInvoices] = useState<readonly InvoiceListItem[]>([]);
  const [collectedThisMonthCents, setCollectedThisMonthCents] = useState(0);
  // Start as loading only if there is no cached data to show immediately.
  const [isLoading, setIsLoading] = useState(() => invoicesCache.get(CACHE_KEY) === null);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);
  const fetchGenerationRef = useRef(0);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const generation = ++fetchGenerationRef.current;

    const cached = invoicesCache.get(CACHE_KEY);
    const hasCachedData = cached !== null;

    if (hasCachedData) {
      setInvoices(cached.data.invoices);
      setCollectedThisMonthCents(cached.data.collectedThisMonthCents);
      setIsLoading(false);
    }

    try {
      const res = await fetch('/api/admin/invoices');
      if (!res.ok) {
        // Generation-gated like the success path: a stale in-flight error must
        // not overwrite state after a newer fetch has already resolved.
        if (!hasCachedData && generation === fetchGenerationRef.current) {
          setError('Failed to load invoices');
        }
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { invoices: InvoiceListItem[]; collectedThisMonthCents: number };
      };
      if (body.success) {
        const fresh: InvoicesPayload = {
          invoices: body.data.invoices,
          collectedThisMonthCents: body.data.collectedThisMonthCents ?? 0,
        };
        if (generation === fetchGenerationRef.current) {
          setInvoices(fresh.invoices);
          setCollectedThisMonthCents(fresh.collectedThisMonthCents);
          invoicesCache.set(CACHE_KEY, fresh);
          setError(null);
        }
      }
    } catch {
      if (!hasCachedData && generation === fetchGenerationRef.current) {
        setError('Could not connect to server. Please try again.');
      }
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  const sendReminder = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/send-reminder`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        invoicesCache.invalidate(CACHE_KEY);
        isFetchingRef.current = false; // a stale in-flight revalidation must not block the post-mutation refetch
        ++fetchGenerationRef.current; // discard any stale in-flight response
        await fetchAll();
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll],
  );

  const voidInvoice = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/void`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        invoicesCache.invalidate(CACHE_KEY);
        isFetchingRef.current = false; // a stale in-flight revalidation must not block the post-mutation refetch
        ++fetchGenerationRef.current; // discard any stale in-flight response
        await fetchAll();
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll],
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  return { invoices, collectedThisMonthCents, isLoading, error, refetch: fetchAll, sendReminder, voidInvoice };
}
