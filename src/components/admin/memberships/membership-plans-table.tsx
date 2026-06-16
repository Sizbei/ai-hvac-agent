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
import type { MembershipPlan } from '@/hooks/use-membership-plans';

interface MembershipPlansTableProps {
  readonly plans: readonly MembershipPlan[];
  readonly isLoading: boolean;
  readonly onEdit: (plan: MembershipPlan) => void;
  readonly onDeactivate: (plan: MembershipPlan) => void;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 3 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-40" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-12" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-7 w-32" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function MembershipPlansTable({
  plans,
  isLoading,
  onEdit,
  onDeactivate,
}: MembershipPlansTableProps) {
  if (!isLoading && plans.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No membership plans yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Billing</TableHead>
          <TableHead className="text-right">Visits/yr</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : (
          plans.map((plan) => (
            <TableRow key={plan.id} className={plan.active ? '' : 'opacity-60'}>
              <TableCell className="font-medium">
                {plan.name}
                {plan.description && (
                  <span className="block text-xs text-muted-foreground">
                    {plan.description}
                  </span>
                )}
                {!plan.active && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    (inactive)
                  </span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="capitalize">
                  {plan.billingPeriod}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {plan.visitsPerYear > 0 ? plan.visitsPerYear : '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCentsExact(plan.priceCents)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => onEdit(plan)}>
                    Edit
                  </Button>
                  {plan.active && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDeactivate(plan)}
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
