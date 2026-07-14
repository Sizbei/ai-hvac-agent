'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, AlertCircle, Search } from 'lucide-react';
import { useInventory, type InventorySortKey } from '@/hooks/use-inventory';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
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

const INVENTORY_SORT_OPTIONS: ReadonlyArray<{ value: InventorySortKey; label: string }> = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'qty_asc', label: 'Qty (low–high)' },
  { value: 'qty_desc', label: 'Qty (high–low)' },
];

export default function InventoryPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [belowReorderOnly, setBelowReorderOnly] = useState(false);
  const [sortKey, setSortKey] = useState<InventorySortKey>('name');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);

  // Persist filters to the URL (shareable links + survives refresh). Page is
  // intentionally NOT persisted. Defaults map to '' so they're dropped from the URL.
  const urlFilterState = {
    q: search,
    sort: sortKey === 'name' ? '' : sortKey,
    belowReorder: belowReorderOnly ? '1' : '',
  };
  const restoreFiltersFromUrl = useCallback((p: Record<string, string>) => {
    const sorts: readonly string[] = ['name', 'qty_asc', 'qty_desc'];
    if (p.q) { setSearch(p.q); setDebouncedSearch(p.q); }
    if (p.sort && sorts.includes(p.sort)) setSortKey(p.sort as InventorySortKey);
    if (p.belowReorder === '1') setBelowReorderOnly(true);
  }, []);
  useUrlFilterSync(urlFilterState, restoreFiltersFromUrl);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever the search query, sort, or toggles change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, belowReorderOnly, sortKey]);

  const {
    inventory,
    inventoryTotal,
    purchaseOrders,
    isLoading,
    error,
    refetch,
  } = useInventory({ page, search: debouncedSearch, belowReorder: belowReorderOnly, sort: sortKey });

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

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search inventory"
            placeholder="Search by name or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <select
          aria-label="Sort order"
          value={sortKey}
          onChange={(e) => { setSortKey(e.target.value as InventorySortKey); setPage(1); }}
          className="rounded-xl border bg-card px-3 py-2.5 text-sm font-semibold text-foreground shadow-sm outline-none focus:ring-1 focus:ring-ring"
        >
          {INVENTORY_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <Button
          type="button"
          variant={belowReorderOnly ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setBelowReorderOnly((v) => !v)}
          aria-pressed={belowReorderOnly}
        >
          Below reorder only
        </Button>
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
