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
  /** True for a read-only invoice mirrored from Fieldpulse. */
  readonly synced: boolean;
}

interface UseInvoicesResult {
  readonly invoices: readonly InvoiceListItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
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

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  return { invoices, isLoading, error, refetch: fetchAll };
}
