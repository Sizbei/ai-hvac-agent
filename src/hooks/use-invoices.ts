'use client';

import { useState, useEffect, useCallback } from 'react';
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
  /** Spillover FP data — needed by Task 11 click-to-expand. */
  readonly fieldpulseData: Record<string, unknown> | null;
}

export interface InvoiceStats {
  readonly outstandingCents: number;
  readonly outstandingCount: number;
  readonly overdueCents: number;
  readonly overdueCount: number;
  /** Max days-past-due across overdue open invoices; 0 when no overdue invoices. */
  readonly oldestOverdueDays: number;
}

export type InvoiceSortKey = 'newest' | 'oldest' | 'balance-high' | 'age-oldest';

export interface UseInvoicesParams {
  readonly page?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly state?: string;
  /** When true, server filters to overdue-only rows (state=open + past due). */
  readonly overdue?: boolean;
  readonly source?: string;
  /** Server-side sort key. */
  readonly sort?: InvoiceSortKey;
  readonly customerId?: string;
  readonly serviceRequestId?: string;
}

interface InvoicesPayload {
  readonly invoices: readonly InvoiceListItem[];
  readonly total: number;
  readonly sourceCounts: Record<string, number>;
  readonly stats: InvoiceStats;
  readonly collectedThisMonthCents: number;
}

interface UseInvoicesResult {
  readonly invoices: readonly InvoiceListItem[];
  readonly total: number;
  readonly sourceCounts: Record<string, number>;
  readonly stats: InvoiceStats | null;
  readonly collectedThisMonthCents: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
  readonly sendReminder: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  readonly voidInvoice: (id: string) => Promise<{ ok: boolean; reason?: string }>;
}

const invoicesCache = createSwrCache<InvoicesPayload>(60_000); // 60s TTL

function makeKey(params: UseInvoicesParams): string {
  const p = params.page ?? 1;
  const l = params.limit ?? 50;
  const s = params.search ?? '';
  const st = params.state ?? '';
  const ov = params.overdue ? '1' : '0';
  const so = params.source ?? '';
  const sk = params.sort ?? '';
  const c = params.customerId ?? '';
  const r = params.serviceRequestId ?? '';
  return `invoices:${p}:${l}:${s}:${st}:${ov}:${so}:${sk}:${c}:${r}`;
}

function buildQuery(params: UseInvoicesParams): string {
  const qs = new URLSearchParams();
  if ((params.page ?? 1) > 1) qs.set('page', String(params.page));
  if (params.limit && params.limit !== 50) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  if (params.state) qs.set('state', params.state);
  if (params.overdue) qs.set('overdue', '1');
  if (params.source) qs.set('source', params.source);
  if (params.sort) qs.set('sort', params.sort);
  if (params.customerId) qs.set('customerId', params.customerId);
  if (params.serviceRequestId) qs.set('serviceRequestId', params.serviceRequestId);
  const q = qs.toString();
  return q ? `?${q}` : '';
}

/**
 * Server-paginated invoices. Params-keyed SWR cache. Returns stats from the
 * server so SummaryBand doesn't need to reduce over the full client list.
 */
export function useInvoices(params: UseInvoicesParams = {}): UseInvoicesResult {
  const key = makeKey(params);

  const [invoices, setInvoices] = useState<readonly InvoiceListItem[]>(
    () => invoicesCache.get(key)?.data.invoices ?? [],
  );
  const [total, setTotal] = useState(() => invoicesCache.get(key)?.data.total ?? 0);
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>(
    () => invoicesCache.get(key)?.data.sourceCounts ?? {},
  );
  const [stats, setStats] = useState<InvoiceStats | null>(
    () => invoicesCache.get(key)?.data.stats ?? null,
  );
  const [collectedThisMonthCents, setCollectedThisMonthCents] = useState(
    () => invoicesCache.get(key)?.data.collectedThisMonthCents ?? 0,
  );
  const [isLoading, setIsLoading] = useState(() => invoicesCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
      if (bust) invoicesCache.invalidate(key);

      const cached = invoicesCache.get(key);
      const hasCachedData = cached !== null;

      if (hasCachedData) {
        setInvoices(cached.data.invoices);
        setTotal(cached.data.total);
        setSourceCounts(cached.data.sourceCounts);
        setStats(cached.data.stats);
        setCollectedThisMonthCents(cached.data.collectedThisMonthCents);
        setIsLoading(false);
      } else {
        setIsLoading(true);
      }

      try {
        const res = await fetch(`/api/admin/invoices${buildQuery(params)}`);
        if (!res.ok) {
          if (!hasCachedData) setError('Failed to load invoices');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: {
            invoices: InvoiceListItem[];
            total: number;
            sourceCounts: Record<string, number>;
            stats: InvoiceStats;
            collectedThisMonthCents: number;
          };
        };
        if (body.success) {
          const fresh: InvoicesPayload = {
            invoices: body.data.invoices,
            total: body.data.total ?? 0,
            sourceCounts: body.data.sourceCounts ?? {},
            stats: body.data.stats,
            collectedThisMonthCents: body.data.collectedThisMonthCents ?? 0,
          };
          setInvoices(fresh.invoices);
          setTotal(fresh.total);
          setSourceCounts(fresh.sourceCounts);
          setStats(fresh.stats);
          setCollectedThisMonthCents(fresh.collectedThisMonthCents);
          invoicesCache.set(key, fresh);
          setError(null);
        }
      } catch {
        if (!hasCachedData) setError('Could not connect to server. Please try again.');
      } finally {
        setIsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const sendReminder = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/send-reminder`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        invoicesCache.invalidate(key);
        await fetchAll({ bust: true });
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll, key],
  );

  const voidInvoice = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/void`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        invoicesCache.invalidate(key);
        await fetchAll({ bust: true });
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll, key],
  );

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const refetch = useCallback(() => fetchAll({ bust: true }), [fetchAll]);

  return { invoices, total, sourceCounts, stats, collectedThisMonthCents, isLoading, error, refetch, sendReminder, voidInvoice };
}
