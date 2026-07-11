'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, AlertCircle, Search } from 'lucide-react';
import { useInventory } from '@/hooks/use-inventory';
import { usePricebook } from '@/hooks/use-pricebook';
import { InventoryTable } from '@/components/admin/inventory/inventory-table';
import { InventoryFormDialog } from '@/components/admin/inventory/inventory-form-dialog';
import { PurchaseOrdersPanel } from '@/components/admin/inventory/purchase-orders-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import type { InventoryItem } from '@/hooks/use-inventory';

const PER_PAGE = 50;

export default function InventoryPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever the search query changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const {
    inventory,
    inventoryTotal,
    purchaseOrders,
    isLoading,
    error,
    refetch,
  } = useInventory({ page, search: debouncedSearch });

  // usePricebook with limit:20000 for the material-picker dropdown — leave as-is.
  const { items: pricebookItems } = usePricebook({ limit: 20000 });

  // Materials available to track / order: active pricebook items of type
  // "material" (inventory LINKS to the pricebook — never a second catalog).
  const materials = useMemo(
    () =>
      pricebookItems
        .filter((i) => i.type === 'material' && i.active)
        .map((i) => ({ id: i.id, name: i.name })),
    [pricebookItems],
  );

  const totalPages = Math.max(1, Math.ceil(inventoryTotal / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(item: InventoryItem): void {
    setEditing(item);
    setFormOpen(true);
  }

  const handleRefetch = useCallback(() => void refetch(), [refetch]);

  return (
    <PageShell>
      <PageHeader
        title="Inventory"
        subtitle="Track stock for pricebook materials and order replenishment."
        actions={
          <Button onClick={handleAddClick}>
            <Plus className="mr-2 h-4 w-4" />
            Track Material
          </Button>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search inventory"
          placeholder="Search by name or SKU..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <InventoryTable
        items={inventory}
        isLoading={isLoading}
        onEdit={handleEditClick}
      />

      {/* Inventory pager bar */}
      {inventoryTotal > 0 && (
        <div className="flex items-center justify-between px-1 py-3 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
          >
            ← Prev
          </Button>
          <span className="tabular-nums text-xs text-muted-foreground">
            {pageLabel(safePage, inventoryTotal, PER_PAGE)}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPage(1)}
              disabled={safePage <= 1}
            >
              First
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPage(totalPages)}
              disabled={safePage >= totalPages}
            >
              Last
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
            >
              Next →
            </Button>
          </div>
        </div>
      )}

      <Separator />

      <PurchaseOrdersPanel
        purchaseOrders={purchaseOrders}
        isLoading={isLoading}
        materials={materials}
        inventory={inventory}
        onChanged={handleRefetch}
      />

      <InventoryFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={handleRefetch}
        editing={editing}
        materials={materials}
      />
    </PageShell>
  );
}
