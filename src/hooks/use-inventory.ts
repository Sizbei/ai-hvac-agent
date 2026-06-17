'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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

interface UseInventoryResult {
  readonly inventory: readonly InventoryItem[];
  readonly purchaseOrders: readonly PurchaseOrderSummary[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's inventory + purchase orders on mount, refetches after
 * mutations. No polling — stock changes infrequently from the admin side.
 */
export function useInventory(): UseInventoryResult {
  const [inventory, setInventory] = useState<readonly InventoryItem[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<
    readonly PurchaseOrderSummary[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const [invRes, poRes] = await Promise.all([
        fetch('/api/admin/inventory'),
        fetch('/api/admin/inventory/purchase-orders'),
      ]);

      if (!invRes.ok || !poRes.ok) {
        setError('Failed to load inventory');
        return;
      }

      const invBody = (await invRes.json()) as {
        success: boolean;
        data: { items: InventoryItem[] };
      };
      const poBody = (await poRes.json()) as {
        success: boolean;
        data: { purchaseOrders: PurchaseOrderSummary[] };
      };

      if (invBody.success) setInventory(invBody.data.items);
      if (poBody.success) setPurchaseOrders(poBody.data.purchaseOrders);
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

  return { inventory, purchaseOrders, isLoading, error, refetch: fetchAll };
}
