'use client';

import { useEffect, useState } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { useMembershipPlans, type MembershipPlan } from '@/hooks/use-membership-plans';
import { MembershipPlansTable } from '@/components/admin/memberships/membership-plans-table';
import { MembershipPlanFormDialog } from '@/components/admin/memberships/membership-plan-form-dialog';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';

export default function MembershipPlansPage() {
  useEffect(() => { document.title = 'Membership Plans · Spears Admin'; }, []);
  const { plans, isLoading, error, refetch } = useMembershipPlans();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MembershipPlan | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<MembershipPlan | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(plan: MembershipPlan): void {
    setEditing(plan);
    setFormOpen(true);
  }

  async function handleDeactivateConfirm(): Promise<void> {
    if (!pendingDeactivate) return;
    setIsConfirming(true);
    setDeactivateError(null);
    try {
      const res = await fetch(`/api/admin/membership-plans/${pendingDeactivate.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setPendingDeactivate(null);
        void refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        setDeactivateError((body as { error?: string }).error ?? 'Failed to deactivate plan.');
      }
    } catch {
      setDeactivateError('Network error — could not deactivate plan.');
    } finally {
      setIsConfirming(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Membership Plans"
        subtitle="Recurring service-agreement plans customers can enroll in for member pricing."
        actions={
          <Button onClick={handleAddClick}>
            <Plus className="mr-2 h-4 w-4" />
            Add Plan
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <MembershipPlansTable
        plans={plans}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onDeactivate={(plan) => { setDeactivateError(null); setPendingDeactivate(plan); }}
      />

      <MembershipPlanFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => void refetch()}
        editing={editing}
      />

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => { if (!open) { setPendingDeactivate(null); setDeactivateError(null); } }}
        title="Deactivate plan?"
        description={pendingDeactivate ? `"${pendingDeactivate.name}" will be marked inactive and unavailable for new enrollments. You can re-activate it later.` : ''}
        confirmLabel="Deactivate"
        confirmingLabel="Deactivating…"
        isConfirming={isConfirming}
        error={deactivateError}
        onConfirm={() => { void handleDeactivateConfirm(); }}
      />
    </PageShell>
  );
}
