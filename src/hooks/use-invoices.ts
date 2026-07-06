'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface InvoiceListItem {
  readonly id: string;
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: string;
  /** Which FSM this read-only invoice is mirrored from, or null when native. */
  readonly syncedSource: "fieldpulse" | "housecall" | null;
  readonly customerName: string | null;
  readonly lastReminderSentAt: string | null;
}

interface UseInvoicesResult {
  readonly invoices: readonly InvoiceListItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
  readonly sendReminder: (id: string) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Loads the org's invoices on mount, refetches after mutations. No polling —
 * invoices change at human pace. Modeled on use-estimates.
 */
export function useInvoices(): UseInvoicesResult {
  const [invoices, setInvoices] = useState<readonly InvoiceListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/invoices');
      if (!res.ok) {
        setError('Failed to load invoices');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { invoices: InvoiceListItem[] };
      };
      if (body.success) setInvoices(body.data.invoices);
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  const sendReminder = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/send-reminder`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        await fetchAll();
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll],
  );

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  return { invoices, isLoading, error, refetch: fetchAll, sendReminder };
}
