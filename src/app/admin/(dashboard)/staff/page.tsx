'use client';

import { useState } from 'react';
import { UserPlus, AlertCircle } from 'lucide-react';
import { useAdminStaff } from '@/hooks/use-admin-staff';
import { StaffTable } from '@/components/admin/staff-table';
import { StaffFormDialog } from '@/components/admin/staff-form-dialog';
import { StaffResetPasswordDialog } from '@/components/admin/staff-reset-password-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { StaffRecord } from '@/lib/admin/types';

export default function StaffPage() {
  const { staff, currentUserId, isLoading, error, refetch } = useAdminStaff();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<StaffRecord | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(member: StaffRecord): void {
    setEditing(member);
    setFormOpen(true);
  }

  function handleResetClick(member: StaffRecord): void {
    setResetTarget(member);
    setResetOpen(true);
  }

  function handleSuccess(): void {
    void refetch();
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="text-sm text-muted-foreground">
            Manage admins and technicians, roles, and passwords.
          </p>
        </div>
        <Button onClick={handleAddClick}>
          <UserPlus className="mr-2 h-4 w-4" />
          Add Staff
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <StaffTable
        staff={staff}
        currentUserId={currentUserId}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onResetPassword={handleResetClick}
      />

      <StaffFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={handleSuccess}
        staff={editing}
        isSelf={editing !== null && editing.id === currentUserId}
      />

      <StaffResetPasswordDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onSuccess={handleSuccess}
        staff={resetTarget}
      />
    </div>
  );
}
