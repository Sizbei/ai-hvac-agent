'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createSwrCache } from '@/lib/admin/swr-cache';

export interface InventoryItem {
  readonly id: string;
  readonly pricebookItemId: string;
  readonly itemName: string;
  readonly quantityOnHand: number;
  readonly reorderPoint: number | null;
  readonly unitCostCents: number;
  readonly location: string | null;
  readonly belowReorder: boolean;
}

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly vendorName: string;
  readonly status: string;
  readonly totalCents: number;
  readonly notes: string | null;
  readonly orderedAt: string | null;
  readonly receivedAt: string | null;
  readonly createdAt: string;
}

interface InventoryPayload {
  readonly items: readonly InventoryItem[];
  readonly total: number;
}

interface PurchaseOrderPayload {
  readonly purchaseOrders: readonly PurchaseOrderSummary[];
  readonly total: number;
}

const inventoryCache = createSwrCache<InventoryPayload>(60_000); // 60s TTL
const poCache = createSwrCache<PurchaseOrderPayload>(60_000);

export type InventorySortKey = 'name' | 'qty_asc' | 'qty_desc';

interface UseInventoryParams {
  readonly page?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly belowReorder?: boolean;
  readonly sort?: InventorySortKey;
}

interface UseInventoryResult {
  readonly inventory: readonly InventoryItem[];
  readonly inventoryTotal: number;
  readonly purchaseOrders: readonly PurchaseOrderSummary[];
  readonly purchaseOrdersTotal: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's inventory + purchase orders on mount, refetches after
 * mutations. Server-paginated; caller supplies page/limit/search. No polling
 * — stock changes infrequently from the admin side.
 */
export function useInventory(params: UseInventoryParams = {}): UseInventoryResult {
  const page = params.page ?? 1;
  const limit = params.limit ?? 50;
  const search = params.search ?? '';
  const belowReorder = params.belowReorder ?? false;
  const sort = params.sort ?? '';

  const invKey = `inventory:${page}:${limit}:${search}:${belowReorder}:${sort}`;
  // PO panel has no pager of its own — always fetch page 1 regardless of where
  // the inventory table is, so navigating to inventory page 2 doesn't silently
  // show POs 51-100 in the panel below.
  const poKey = `po:1:${limit}`;

  const [inventory, setInventory] = useState<readonly InventoryItem[]>(
    () => inventoryCache.get(invKey)?.data.items ?? [],
  );
  const [inventoryTotal, setInventoryTotal] = useState(
    () => inventoryCache.get(invKey)?.data.total ?? 0,
  );
  const [purchaseOrders, setPurchaseOrders] = useState<readonly PurchaseOrderSummary[]>(
    () => poCache.get(poKey)?.data.purchaseOrders ?? [],
  );
  const [purchaseOrdersTotal, setPurchaseOrdersTotal] = useState(
    () => poCache.get(poKey)?.data.total ?? 0,
  );
  const [isLoading, setIsLoading] = useState(
    () => inventoryCache.get(invKey) === null || poCache.get(poKey) === null,
  );
  const [error, setError] = useState<string | null>(null);

  // Stale-response guard: each fetch captures a sequence number and skips
  // applying results if a newer fetch has already started.
  const fetchSeqRef = useRef(0);

  const fetchAll = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}): Promise<void> => {
      if (bust) {
        inventoryCache.invalidate(invKey);
        poCache.invalidate(poKey);
      }

      const cachedInv = inventoryCache.get(invKey);
      const cachedPo = poCache.get(poKey);

      if (cachedInv && cachedPo) {
        setInventory(cachedInv.data.items);
        setInventoryTotal(cachedInv.data.total);
        setPurchaseOrders(cachedPo.data.purchaseOrders);
        setPurchaseOrdersTotal(cachedPo.data.total);
        return;
      }

      const seq = ++fetchSeqRef.current;
      setIsLoading(true);

      try {
        const invQs = new URLSearchParams();
        if (page > 1) invQs.set('page', String(page));
        if (limit !== 50) invQs.set('limit', String(limit));
        if (search) invQs.set('search', search);
        if (belowReorder) invQs.set('belowReorder', 'true');
        if (sort) invQs.set('sort', sort);

        const poQs = new URLSearchParams();
        // No page param — PO panel always shows page 1 (no pager of its own).
        if (limit !== 50) poQs.set('limit', String(limit));

        const invQuery = invQs.toString();
        const poQuery = poQs.toString();

        const [invRes, poRes] = await Promise.all([
          fetch(`/api/admin/inventory${invQuery ? `?${invQuery}` : ''}`),
          fetch(`/api/admin/inventory/purchase-orders${poQuery ? `?${poQuery}` : ''}`),
        ]);

        // Discard if a newer fetch has already started (rapid page clicks).
        if (seq !== fetchSeqRef.current) return;

        if (!invRes.ok || !poRes.ok) {
          setError('Failed to load inventory');
          return;
        }

        const invBody = (await invRes.json()) as {
          success: boolean;
          data: { items: InventoryItem[]; total: number };
        };
        const poBody = (await poRes.json()) as {
          success: boolean;
          data: { purchaseOrders: PurchaseOrderSummary[]; total: number };
        };

        // Re-check after the JSON parse (more awaits = more time for a race).
        if (seq !== fetchSeqRef.current) return;

        if (invBody.success) {
          setInventory(invBody.data.items);
          setInventoryTotal(invBody.data.total);
          inventoryCache.set(invKey, {
            items: invBody.data.items,
            total: invBody.data.total,
          });
        }
        if (poBody.success) {
          setPurchaseOrders(poBody.data.purchaseOrders);
          setPurchaseOrdersTotal(poBody.data.total);
          poCache.set(poKey, {
            purchaseOrders: poBody.data.purchaseOrders,
            total: poBody.data.total,
          });
        }
        setError(null);
      } catch {
        if (seq === fetchSeqRef.current) {
          setError('Could not connect to server. Please try again.');
        }
      } finally {
        if (seq === fetchSeqRef.current) {
          setIsLoading(false);
        }
      }
    },
    [invKey, poKey, page, limit, search, belowReorder, sort],
  );

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const refetch = useCallback(() => fetchAll({ bust: true }), [fetchAll]);

  return {
    inventory,
    inventoryTotal,
    purchaseOrders,
    purchaseOrdersTotal,
    isLoading,
    error,
    refetch,
  } as const;
}
