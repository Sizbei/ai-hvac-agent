'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { fetchGate, responseApplies } from '@/lib/admin/keyed-fetch';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

export interface EstimateListItem {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: string;
  readonly effectiveCreatedAt: string;
  readonly expiresAt: string | null;
  readonly signedAt: string | null;
  readonly syncedSource: 'fieldpulse' | null;
  readonly fieldpulseStatusName: string | null;
  readonly title: string | null;
  readonly customerName: string | null;
  readonly soldOptionId: string | null;
  /** Options on the estimate (Good/Better/Best); 0 for some FieldPulse imports. */
  readonly optionCount: number;
}

export interface EstimatePipelineStats {
  readonly openCents: number;
  readonly openCount: number;
  readonly staleCents: number;
  readonly staleCount: number;
  readonly wonCents: number;
  readonly wonCount: number;
  readonly lostCents: number;
  readonly lostCount: number;
  readonly draftCents: number;
  readonly draftCount: number;
  readonly winRatePct: number | null;
  readonly avgOpenAgeDays: number;
}

export interface UseEstimatesParams {
  readonly page?: number;
  readonly limit?: number;
  readonly bucket?: 'open' | 'won' | 'lost' | 'draft' | 'not_invoiced';
  readonly customerId?: string;
  readonly serviceRequestId?: string;
  readonly search?: string;
}

interface EstimatesPayload {
  readonly estimates: readonly EstimateListItem[];
  readonly total: number;
  /** Stats may be null on partial server failures; callers must guard. */
  readonly stats: EstimatePipelineStats | null;
}

interface UseEstimatesResult {
  readonly estimates: readonly EstimateListItem[];
  readonly total: number;
  readonly stats: EstimatePipelineStats | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

const estimatesCache = createSwrCache<EstimatesPayload>(60_000); // 60s TTL

function makeKey(params: UseEstimatesParams): string {
  const p = params.page ?? 1;
  const l = params.limit ?? 50;
  const b = params.bucket ?? '';
  const c = params.customerId ?? '';
  const r = params.serviceRequestId ?? '';
  const s = params.search ?? '';
  return `estimates:${p}:${l}:${b}:${c}:${r}:${s}`;
}

function buildQuery(params: UseEstimatesParams): string {
  const qs = new URLSearchParams();
  if ((params.page ?? 1) > 1) qs.set('page', String(params.page));
  if (params.limit && params.limit !== 50) qs.set('limit', String(params.limit));
  if (params.bucket) qs.set('bucket', params.bucket);
  if (params.customerId) qs.set('customerId', params.customerId);
  if (params.serviceRequestId) qs.set('serviceRequestId', params.serviceRequestId);
  if (params.search) qs.set('search', params.search);
  const q = qs.toString();
  return q ? `?${q}` : '';
}

/**
 * Server-paginated estimates with pipeline stats. Params-keyed SWR cache.
 * Returns stats from the server so the KPI band doesn't need to reduce over
 * the full client list.
 */
export function useEstimates(params: UseEstimatesParams = {}): UseEstimatesResult {
  const key = makeKey(params);

  const [estimates, setEstimates] = useState<readonly EstimateListItem[]>(
    () => estimatesCache.get(key)?.data.estimates ?? [],
  );
  const [total, setTotal] = useState(() => estimatesCache.get(key)?.data.total ?? 0);
  const [stats, setStats] = useState<EstimatePipelineStats | null>(
    () => estimatesCache.get(key)?.data.stats ?? null,
  );
  const [isLoading, setIsLoading] = useState(() => estimatesCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);
  // Dedup: prevent concurrent fetches for the same key (e.g. StrictMode double-mount).
  // Keyed, so a `?bucket=` deep link restored while the default bucket's first
  // fetch is in flight still fetches (Task 7 parked).
  const inFlightKeyRef = useRef<string | null>(null);
  const currentKeyRef = useRef(key);
  useEffect(() => {
    currentKeyRef.current = key;
  }, [key]);

  const fetchAll = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
      if (bust) estimatesCache.invalidate(key);

      const cached = estimatesCache.get(key);
      if (cached) {
        setEstimates(cached.data.estimates);
        setTotal(cached.data.total);
        setStats(cached.data.stats);
        setIsLoading(false);
        return;
      }

      // Bail if another fetch is already in flight (unless busting) — guard the
      // network request only, never the synchronous cache-hit path above.
      if (fetchGate({ inFlightKey: inFlightKeyRef.current, key, bust }) === 'skip') return;

      inFlightKeyRef.current = key;
      setIsLoading(true);
      try {
        const res = await adminFetch(`/api/admin/estimates${buildQuery(params)}`);
        if (!res.ok) {
          if (responseApplies(key, currentKeyRef.current)) setError('Failed to load estimates');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: EstimatesPayload;
        };
        if (body.success) {
          estimatesCache.set(key, body.data);
          // A late answer for an older key (the default bucket) never replaces the current rows.
          if (!responseApplies(key, currentKeyRef.current)) return;
          setEstimates(body.data.estimates);
          setTotal(body.data.total);
          setStats(body.data.stats ?? null);
          setError(null);
        }
      } catch (err) {
        if (err instanceof AdminAuthRedirectError) return;
        setError('Could not connect to server. Please try again.');
      } finally {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = null;
        if (responseApplies(key, currentKeyRef.current)) setIsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Fetch on mount and whenever key changes (page/bucket/etc).
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  return { estimates, total, stats, isLoading, error, refetch: () => fetchAll({ bust: true }) };
}
