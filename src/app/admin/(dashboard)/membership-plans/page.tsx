'use client';

import { useState } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { useMembershipPlans, type MembershipPlan } from '@/hooks/use-membership-plans';
import { MembershipPlansTable } from '@/components/admin/memberships/membership-plans-table';
import { MembershipPlanFormDialog } from '@/components/admin/memberships/membership-plan-form-dialog';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

export default function MembershipPlansPage() {
  useAdminPageTitle('Membership plans');
  const [showInactive, setShowInactive] = useState(false);
  const { plans, isLoading, error, refetch } = useMembershipPlans(showInactive);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MembershipPlan | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<MembershipPlan | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

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

  async function handleReactivate(plan: MembershipPlan): Promise<void> {
    if (reactivatingId) return;
    setReactivatingId(plan.id);
    setReactivateError(null);
    try {
      const res = await fetch(`/api/admin/membership-plans/${plan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      if (res.ok) {
        void refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        setReactivateError((body as { error?: string }).error ?? 'Failed to reactivate plan.');
      }
    } catch {
      setReactivateError('Network error — could not reactivate plan.');
    } finally {
      setReactivatingId(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Membership plans"
        subtitle="Recurring service-agreement plans customers can enroll in for member pricing."
        actions={
          <Button onClick={handleAddClick}>
            <Plus className="mr-2 h-4 w-4" />
            Add plan
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {reactivateError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{reactivateError}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant={showInactive ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setShowInactive((v) => !v)}
          aria-pressed={showInactive}
        >
          Show inactive
        </Button>
      </div>

      <MembershipPlansTable
        plans={plans}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onDeactivate={(plan) => { setDeactivateError(null); setPendingDeactivate(plan); }}
        onReactivate={(plan) => { void handleReactivate(plan); }}
        reactivatingId={reactivatingId}
        onAdd={handleAddClick}
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
