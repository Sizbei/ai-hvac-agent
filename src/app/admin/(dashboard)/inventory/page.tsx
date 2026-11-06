'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useInventory, type InventorySortKey } from '@/hooks/use-inventory';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import { usePricebook } from '@/hooks/use-pricebook';
import { InventoryTable } from '@/components/admin/inventory/inventory-table';
import { InventoryFormDialog } from '@/components/admin/inventory/inventory-form-dialog';
import { PurchaseOrdersPanel } from '@/components/admin/inventory/purchase-orders-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { Pager } from '@/components/admin/ui/pager';
import type { InventoryItem } from '@/hooks/use-inventory';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

const PER_PAGE = 50;

const INVENTORY_SORT_OPTIONS: ReadonlyArray<{ value: InventorySortKey; label: string }> = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'qty_asc', label: 'Qty (low–high)' },
  { value: 'qty_desc', label: 'Qty (high–low)' },
];

export default function InventoryPage() {
  useAdminPageTitle('Inventory');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [belowReorderOnly, setBelowReorderOnly] = useState(false);
  const [sortKey, setSortKey] = useState<InventorySortKey>('name');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

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
    trackedPricebookItemIds,
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
        .map((i) => ({ id: i.id, name: i.name, costCents: i.costCents })),
    [pricebookItems],
  );

  // Track material offers only materials with no stock row yet — picking a
  // tracked one used to overwrite its counts (the server now refuses, 409).
  const untrackedMaterials = useMemo(() => {
    const tracked = new Set(trackedPricebookItemIds);
    return materials.filter((m) => !tracked.has(m.id));
  }, [materials, trackedPricebookItemIds]);

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
            Track material
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
        <Select
          value={sortKey}
          onValueChange={(value) => { setSortKey(value as InventorySortKey); setPage(1); }}
        >
          <SelectTrigger className="w-[160px]" aria-label="Sort order">
            <SelectValue>
              {(v: unknown) => selectLabel(INVENTORY_SORT_OPTIONS, v, 'Sort')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {INVENTORY_SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      {/* A failed load is one error with Try again — never "No materials
          tracked" or an empty purchase-order list. */}
      {savedNotice && (
        <p role="status" className="text-sm text-success">
          {savedNotice}
        </p>
      )}

      {error && !isLoading ? (
        <LoadErrorState title="Couldn't load inventory." onRetry={refetch} />
      ) : (
      <>
      <InventoryTable
        items={inventory}
        isLoading={isLoading}
        onEdit={handleEditClick}
      />

      {inventoryTotal > 0 && (
        <Pager
          page={safePage}
          totalPages={totalPages}
          total={inventoryTotal}
          perPage={PER_PAGE}
          onPageChange={setPage}
          showFirstLast
        />
      )}

      <Separator />

      <PurchaseOrdersPanel
        purchaseOrders={purchaseOrders}
        isLoading={isLoading}
        materials={materials}
        inventory={inventory}
        onChanged={handleRefetch}
      />
      </>
      )}

      <InventoryFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => {
          handleRefetch();
          setSavedNotice(editing ? 'Stock updated.' : 'Material tracked.');
          setTimeout(() => setSavedNotice(null), 4000);
        }}
        editing={editing}
        materials={untrackedMaterials}
      />
    </PageShell>
  );
}
