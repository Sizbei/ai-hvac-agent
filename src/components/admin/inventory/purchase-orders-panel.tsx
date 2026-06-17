'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PurchaseOrderFormDialog } from './purchase-order-form-dialog';
import type {
  PurchaseOrderSummary,
  InventoryItem,
} from '@/hooks/use-inventory';
import type { MaterialOption } from './inventory-form-dialog';

interface PurchaseOrdersPanelProps {
  readonly purchaseOrders: readonly PurchaseOrderSummary[];
  readonly isLoading: boolean;
  readonly materials: readonly MaterialOption[];
  /** Materials currently tracked in inventory (for default unit-cost hints). */
  readonly inventory: readonly InventoryItem[];
  readonly onChanged: () => void;
}

const STATUS_VARIANT: Record<
  string,
  'secondary' | 'default' | 'outline' | 'destructive'
> = {
  draft: 'outline',
  ordered: 'secondary',
  received: 'default',
  cancelled: 'destructive',
};

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 3 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-7 w-28" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function PurchaseOrdersPanel({
  purchaseOrders,
  isLoading,
  materials,
  inventory,
  onChanged,
}: PurchaseOrdersPanelProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function transition(id: string, action: 'order' | 'receive'): Promise<void> {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/inventory/purchase-orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Purchase Orders</h2>
          <p className="text-sm text-muted-foreground">
            Order stock from a vendor. Receiving a PO adds its quantities to
            inventory.
          </p>
        </div>
        <Button onClick={() => setFormOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New PO
        </Button>
      </div>

      {!isLoading && purchaseOrders.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">
          No purchase orders yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : (
              purchaseOrders.map((po) => (
                <TableRow key={po.id}>
                  <TableCell className="font-medium">{po.vendorName}</TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_VARIANT[po.status] ?? 'secondary'}
                      className="capitalize"
                    >
                      {po.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentsExact(po.totalCents)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {po.status === 'draft' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === po.id}
                          onClick={() => void transition(po.id, 'order')}
                        >
                          Mark Ordered
                        </Button>
                      )}
                      {(po.status === 'draft' || po.status === 'ordered') && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === po.id}
                          onClick={() => void transition(po.id, 'receive')}
                        >
                          Receive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      <PurchaseOrderFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={onChanged}
        materials={materials}
        inventory={inventory}
      />
    </section>
  );
}
