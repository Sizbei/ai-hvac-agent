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
import { formatCentsExact } from '@/lib/admin/money-format';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import type { MembershipPlan } from '@/hooks/use-membership-plans';

interface MembershipPlansTableProps {
  readonly plans: readonly MembershipPlan[];
  readonly isLoading: boolean;
  readonly onEdit: (plan: MembershipPlan) => void;
  readonly onDeactivate: (plan: MembershipPlan) => void;
}

export function MembershipPlansTable({
  plans,
  isLoading,
  onEdit,
  onDeactivate,
}: MembershipPlansTableProps) {
  if (isLoading) {
    return <SkeletonTable rows={3} cols={5} />;
  }

  // Empty state is handled by the parent page; render nothing when empty
  if (plans.length === 0) {
    return null;
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
        {plans.map((plan) => (
          <TableRow key={plan.id} className={plan.active ? '' : 'opacity-60'}>
            <TableCell className="font-medium">
              <div className="flex flex-wrap items-center gap-2">
                {plan.name}
                {!plan.active && (
                  <Badge
                    variant="outline"
                    className="bg-muted text-muted-foreground border-border text-[11px]"
                  >
                    Inactive
                  </Badge>
                )}
              </div>
              {plan.description && (
                <span className="block text-xs text-muted-foreground">
                  {plan.description}
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
        ))}
      </TableBody>
    </Table>
  );
}
