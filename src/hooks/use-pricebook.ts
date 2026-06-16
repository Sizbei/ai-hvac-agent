'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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
}

export interface TaxRate {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string | null;
  readonly rateBps: number;
  readonly isDefault: boolean;
  readonly active: boolean;
}

interface UsePricebookResult {
  readonly items: readonly PricebookItem[];
  readonly taxRates: readonly TaxRate[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's pricebook items + tax rates on mount, refetches after
 * mutations. No polling — the catalog changes infrequently.
 */
export function usePricebook(): UsePricebookResult {
  const [items, setItems] = useState<readonly PricebookItem[]>([]);
  const [taxRates, setTaxRates] = useState<readonly TaxRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const [itemsRes, taxRes] = await Promise.all([
        fetch('/api/admin/pricebook'),
        fetch('/api/admin/pricebook/tax-rates'),
      ]);

      if (!itemsRes.ok || !taxRes.ok) {
        setError('Failed to load pricebook');
        return;
      }

      const itemsBody = (await itemsRes.json()) as {
        success: boolean;
        data: { items: PricebookItem[] };
      };
      const taxBody = (await taxRes.json()) as {
        success: boolean;
        data: { taxRates: TaxRate[] };
      };

      if (itemsBody.success) setItems(itemsBody.data.items);
      if (taxBody.success) setTaxRates(taxBody.data.taxRates);
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

  return { items, taxRates, isLoading, error, refetch: fetchAll };
}
