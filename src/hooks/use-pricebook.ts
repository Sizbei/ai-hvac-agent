'use client';

import { useState, useEffect, useCallback } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';

export interface PricebookItem {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly sku: string | null;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly costCents: number;
  readonly markupPct: number;
  readonly priceCents: number;
  readonly memberPriceCents: number | null;
  readonly hours: number | null;
  readonly warranty: string | null;
  readonly active: boolean;
  readonly isLaborItem: boolean;
  readonly fieldpulseItemId: string | null;
  readonly fieldpulseData: Record<string, unknown> | null;
}

export interface TaxRate {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string | null;
  readonly rateBps: number;
  readonly isDefault: boolean;
  readonly active: boolean;
}

interface PricebookPayload {
  readonly items: readonly PricebookItem[];
  readonly total: number;
  readonly types: readonly string[];
}

const pricebookCache = createSwrCache<PricebookPayload>(60_000); // 60s TTL

interface UsePricebookParams {
  readonly page?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly type?: string;
  readonly includeInactive?: boolean;
  readonly isLaborItem?: boolean;
}

interface UsePricebookResult {
  readonly items: readonly PricebookItem[];
  readonly total: number;
  readonly types: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Server-paginated pricebook items list. Refetches whenever page, search, or
 * type filter changes. Caller is responsible for debouncing the search term.
 * `total` drives the pager; `types` fills the type-filter dropdown.
 */
export function usePricebook(params: UsePricebookParams = {}): UsePricebookResult {
  const page = params.page ?? 1;
  const limit = params.limit ?? 50;
  const search = params.search ?? '';
  const type = params.type ?? '';
  const includeInactive = params.includeInactive ?? false;
  const isLaborItem = params.isLaborItem ?? false;

  const key = `pricebook:${page}:${limit}:${type}:${search}:${includeInactive}:${isLaborItem}`;

  const [items, setItems] = useState<readonly PricebookItem[]>(
    () => pricebookCache.get(key)?.data.items ?? [],
  );
  const [total, setTotal] = useState(() => pricebookCache.get(key)?.data.total ?? 0);
  const [types, setTypes] = useState<readonly string[]>(
    () => pricebookCache.get(key)?.data.types ?? [],
  );
  const [isLoading, setIsLoading] = useState(() => pricebookCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}) => {
      if (bust) pricebookCache.invalidate(key);

      const cached = pricebookCache.get(key);
      const hasCachedData = cached !== null;
      if (hasCachedData) {
        setItems(cached.data.items);
        setTotal(cached.data.total);
        setTypes(cached.data.types);
      } else {
        setIsLoading(true);
      }

      try {
        const qs = new URLSearchParams();
        if (page > 1) qs.set('page', String(page));
        if (limit !== 50) qs.set('limit', String(limit));
        if (search) qs.set('search', search);
        if (type) qs.set('type', type);
        if (includeInactive) qs.set('includeInactive', 'true');
        if (isLaborItem) qs.set('isLaborItem', 'true');
        const query = qs.toString();
        const res = await fetch(`/api/admin/pricebook${query ? `?${query}` : ''}`);
        const json = await res.json();
        if (json.success) {
          setError(null);
          setItems(json.data.items);
          setTotal(json.data.total);
          setTypes(json.data.types ?? []);
          pricebookCache.set(key, {
            items: json.data.items,
            total: json.data.total,
            types: json.data.types ?? [],
          });
        } else if (!hasCachedData) {
          setError(json.error?.message ?? 'Failed to load pricebook');
        }
      } catch {
        if (!hasCachedData) setError('Network error');
      } finally {
        setIsLoading(false);
      }
    },
    [key, page, limit, search, type, includeInactive, isLaborItem],
  );

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetch_();
  }, [fetch_]);

  const refetch = useCallback(() => fetch_({ bust: true }), [fetch_]);

  return { items, total, types, isLoading, error, refetch } as const;
}

// ── Tax rates (separate small fetch, unchanged) ───────────────────────────────

interface UseTaxRatesResult {
  readonly taxRates: readonly TaxRate[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's tax rates on mount. Kept separate from usePricebook so the
 * TaxRatesPanel can refresh independently without triggering a full pricebook
 * page refetch.
 */
export function useTaxRates(): UseTaxRatesResult {
  const [taxRates, setTaxRates] = useState<readonly TaxRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/pricebook/tax-rates');
      if (!res.ok) {
        setError('Failed to load tax rates');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { taxRates: TaxRate[] };
      };
      if (body.success) {
        setTaxRates(body.data.taxRates);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  return { taxRates, isLoading, error, refetch: fetchAll } as const;
}
