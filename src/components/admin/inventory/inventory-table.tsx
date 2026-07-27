'use client';

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
import { EmptyState } from '@/components/admin/ui/empty-state';
import { Package } from 'lucide-react';
import { formatCentsExact } from '@/lib/admin/money-format';
import { cn } from '@/lib/utils';
import type { InventoryItem } from '@/hooks/use-inventory';

interface InventoryTableProps {
  readonly items: readonly InventoryItem[];
  readonly isLoading: boolean;
  readonly onEdit: (item: InventoryItem) => void;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-40" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-7 w-16" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function InventoryTable({ items, isLoading, onEdit }: InventoryTableProps) {
  if (!isLoading && items.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No materials tracked"
        description="Add a stock row from a pricebook material to start tracking inventory."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Material</TableHead>
          <TableHead className="text-right">On hand</TableHead>
          <TableHead className="text-right">Reorder at</TableHead>
          <TableHead className="text-right">Unit cost</TableHead>
          <TableHead>Location</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : (
          items.map((item) => (
            <TableRow
              key={item.id}
              className={cn(item.belowReorder && 'bg-warning-light/40')}
            >
              <TableCell className="font-medium">
                {item.itemName}
                {item.belowReorder && (
                  <Badge
                    className="ml-2 align-middle bg-warning-light text-warning border-0"
                  >
                    Low
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {item.quantityOnHand}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {item.reorderPoint ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCentsExact(item.unitCostCents)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {item.location ?? '—'}
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => onEdit(item)}>
                    Edit
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
