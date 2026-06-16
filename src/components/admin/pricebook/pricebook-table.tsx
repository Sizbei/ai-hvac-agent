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
import { formatCentsExact } from '@/lib/admin/money-format';
import { computeMargin } from '@/lib/admin/margin';
import type { PricebookItem } from '@/hooks/use-pricebook';

interface PricebookTableProps {
  readonly items: readonly PricebookItem[];
  readonly isLoading: boolean;
  readonly onEdit: (item: PricebookItem) => void;
  readonly onDeactivate: (item: PricebookItem) => void;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="secondary" className="capitalize">
      {type}
    </Badge>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-40" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-12" /></TableCell>
          <TableCell><Skeleton className="h-7 w-32" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function PricebookTable({
  items,
  isLoading,
  onEdit,
  onDeactivate,
}: PricebookTableProps) {
  if (!isLoading && items.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No pricebook items yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>SKU</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Member</TableHead>
          <TableHead className="text-right">Margin</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : (
          items.map((item) => (
            <TableRow key={item.id} className={item.active ? '' : 'opacity-60'}>
              <TableCell className="font-medium">
                {item.name}
                {!item.active && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    (inactive)
                  </span>
                )}
              </TableCell>
              <TableCell>
                <TypeBadge type={item.type} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {item.sku ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCentsExact(item.priceCents)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {item.memberPriceCents != null
                  ? formatCentsExact(item.memberPriceCents)
                  : '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {item.priceCents > 0
                  ? `${(
                      computeMargin(item.priceCents, item.costCents).marginPct *
                      100
                    ).toFixed(1)}%`
                  : '—'}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(item)}
                  >
                    Edit
                  </Button>
                  {item.active && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDeactivate(item)}
                    >
                      Deactivate
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
