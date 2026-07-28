'use client';

import { useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
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
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { EmptyState } from '@/components/admin/ui/empty-state';
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

export function PurchaseOrdersPanel({
  purchaseOrders,
  isLoading,
  materials,
  inventory,
  onChanged,
}: PurchaseOrdersPanelProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A failed order/receive must NOT silently no-op — "Receive" adds stock, so a
  // swallowed failure would make an admin believe inventory was updated when it
  // wasn't.
  const [actionError, setActionError] = useState<string | null>(null);

  async function transition(id: string, action: 'order' | 'receive'): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/inventory/purchase-orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        onChanged();
      } else {
        setActionError(
          action === 'receive'
            ? "Couldn't receive that PO — inventory was NOT updated. Try again."
            : "Couldn't update that purchase order. Try again.",
        );
      }
    } catch {
      setActionError('Network error — the purchase order was not updated.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4">
      <SectionHeading
        as="h2"
        title="Purchase orders"
        description="Order stock from a vendor. Receiving a PO adds its quantities to inventory."
        right={
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New PO
          </Button>
        }
      />

      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {isLoading ? (
        // 3 rows × 4 cols mirrors the real table (Vendor, Status, Total, Actions)
        <SkeletonTable rows={3} cols={4} />
      ) : purchaseOrders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="No purchase orders"
          description="Create a PO to order stock from a vendor. Receiving it will update inventory."
        />
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
            {(
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
                          Mark ordered
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
