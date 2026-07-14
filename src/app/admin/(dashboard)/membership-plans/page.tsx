'use client';

import { useState } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { useMembershipPlans, type MembershipPlan } from '@/hooks/use-membership-plans';
import { MembershipPlansTable } from '@/components/admin/memberships/membership-plans-table';
import { MembershipPlanFormDialog } from '@/components/admin/memberships/membership-plan-form-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function MembershipPlansPage() {
  const { plans, isLoading, error, refetch } = useMembershipPlans();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MembershipPlan | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(plan: MembershipPlan): void {
    setEditing(plan);
    setFormOpen(true);
  }

  async function handleDeactivate(plan: MembershipPlan): Promise<void> {
    if (!window.confirm(`Deactivate "${plan.name}"?`)) return;
    setDeactivateError(null);
    const res = await fetch(`/api/admin/membership-plans/${plan.id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      void refetch();
    } else {
      const body = await res.json().catch(() => ({}));
      setDeactivateError((body as { error?: string }).error ?? 'Failed to deactivate plan.');
    }
  }

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Membership Plans</h1>
          <p className="text-sm text-muted-foreground">
            Recurring service-agreement plans customers can enroll in for member
            pricing.
          </p>
        </div>
        <Button onClick={handleAddClick}>
          <Plus className="mr-2 h-4 w-4" />
          Add Plan
        </Button>
      </div>

      {(error ?? deactivateError) && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error ?? deactivateError}</AlertDescription>
        </Alert>
      )}

      <MembershipPlansTable
        plans={plans}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onDeactivate={(plan) => void handleDeactivate(plan)}
      />

      <MembershipPlanFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => void refetch()}
        editing={editing}
      />
    </div>
  );
}
