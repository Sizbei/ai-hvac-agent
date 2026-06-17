'use client';

import { useMemo, useState } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { useInventory } from '@/hooks/use-inventory';
import { usePricebook } from '@/hooks/use-pricebook';
import { InventoryTable } from '@/components/admin/inventory/inventory-table';
import { InventoryFormDialog } from '@/components/admin/inventory/inventory-form-dialog';
import { PurchaseOrdersPanel } from '@/components/admin/inventory/purchase-orders-panel';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import type { InventoryItem } from '@/hooks/use-inventory';

export default function InventoryPage() {
  const {
    inventory,
    purchaseOrders,
    isLoading,
    error,
    refetch,
  } = useInventory();
  const { items: pricebookItems } = usePricebook();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);

  // Materials available to track / order: active pricebook items of type
  // "material" (inventory LINKS to the pricebook — never a second catalog).
  const materials = useMemo(
    () =>
      pricebookItems
        .filter((i) => i.type === 'material' && i.active)
        .map((i) => ({ id: i.id, name: i.name })),
    [pricebookItems],
  );

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(item: InventoryItem): void {
    setEditing(item);
    setFormOpen(true);
  }

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

      <Separator />

      <PurchaseOrdersPanel
        purchaseOrders={purchaseOrders}
        isLoading={isLoading}
        materials={materials}
        inventory={inventory}
        onChanged={() => void refetch()}
      />

      <InventoryFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => void refetch()}
        editing={editing}
        materials={materials}
      />
    </PageShell>
  );
}
