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
import { CreditCard, Plus } from 'lucide-react';
import { formatCentsExact } from '@/lib/admin/money-format';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import { EmptyState } from '@/components/admin/ui/empty-state';
import type { MembershipPlan } from '@/hooks/use-membership-plans';
import { humanizeCode } from '@/lib/admin/display-labels';

interface MembershipPlansTableProps {
  readonly plans: readonly MembershipPlan[];
  readonly isLoading: boolean;
  readonly onEdit: (plan: MembershipPlan) => void;
  readonly onDeactivate: (plan: MembershipPlan) => void;
  readonly onReactivate: (plan: MembershipPlan) => void;
  /** id of the plan currently being reactivated, if any — disables its button. */
  readonly reactivatingId?: string | null;
  readonly onAdd: () => void;
}

function PlanActions({
  plan,
  onEdit,
  onDeactivate,
  onReactivate,
  reactivatingId,
}: {
  readonly plan: MembershipPlan;
  readonly onEdit: (plan: MembershipPlan) => void;
  readonly onDeactivate: (plan: MembershipPlan) => void;
  readonly onReactivate: (plan: MembershipPlan) => void;
  readonly reactivatingId: string | null;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" onClick={() => onEdit(plan)}>
        Edit
      </Button>
      {plan.active ? (
        <Button variant="outline" size="sm" onClick={() => onDeactivate(plan)}>
          Deactivate
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={reactivatingId === plan.id}
          onClick={() => onReactivate(plan)}
        >
          {reactivatingId === plan.id ? 'Reactivating…' : 'Reactivate'}
        </Button>
      )}
    </div>
  );
}

function billingLabel(period: string): string {
  return humanizeCode(period);
}

export function MembershipPlansTable({
  plans,
  isLoading,
  onEdit,
  onDeactivate,
  onReactivate,
  reactivatingId = null,
  onAdd,
}: MembershipPlansTableProps) {
  if (isLoading) {
    return <SkeletonTable rows={3} cols={5} />;
  }

  if (plans.length === 0) {
    return (
      <EmptyState
        icon={CreditCard}
        title="No membership plans yet"
        description="Set up your maintenance agreements, like an ice machine or boiler service contract. Members get their own pricing on estimates and invoices."
        action={
          <Button onClick={onAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Add plan
          </Button>
        }
      />
    );
  }

  return (
    <>
    {/* Phone: one card per plan so price, billing and actions stay visible. */}
    <ul className="flex flex-col divide-y divide-border sm:hidden">
      {plans.map((plan) => (
        <li key={plan.id} className={`flex flex-col gap-2 px-4 py-3 ${plan.active ? '' : 'opacity-60'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {plan.name}
                {!plan.active && (
                  <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-[11px]">
                    Inactive
                  </Badge>
                )}
              </p>
              {plan.description && (
                <p className="text-xs text-muted-foreground">{plan.description}</p>
              )}
            </div>
            <span className="shrink-0 font-mono text-sm tabular-nums">
              {formatCentsExact(plan.priceCents)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {billingLabel(plan.billingPeriod)} ·{' '}
            {plan.visitsPerYear > 0
              ? `${plan.visitsPerYear} visit${plan.visitsPerYear === 1 ? '' : 's'} a year`
              : 'No included visits'}
          </p>
          <PlanActions
            plan={plan}
            onEdit={onEdit}
            onDeactivate={onDeactivate}
            onReactivate={onReactivate}
            reactivatingId={reactivatingId}
          />
        </li>
      ))}
    </ul>
    <div className="hidden overflow-x-auto sm:block">
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
              <Badge variant="secondary">
                {billingLabel(plan.billingPeriod)}
              </Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {plan.visitsPerYear > 0 ? plan.visitsPerYear : '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCentsExact(plan.priceCents)}
            </TableCell>
            <TableCell>
              <PlanActions
                plan={plan}
                onEdit={onEdit}
                onDeactivate={onDeactivate}
                onReactivate={onReactivate}
                reactivatingId={reactivatingId}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
    </>
  );
}
