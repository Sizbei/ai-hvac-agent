'use client';

import { useState } from 'react';
import { UserPlus, Mail, AlertCircle } from 'lucide-react';
import { useAdminStaff } from '@/hooks/use-admin-staff';
import { useAdminInvites } from '@/hooks/use-admin-invites';
import { StaffTable } from '@/components/admin/staff-table';
import { StaffFormDialog } from '@/components/admin/staff-form-dialog';
import { StaffResetPasswordDialog } from '@/components/admin/staff-reset-password-dialog';
import { InviteDialog } from '@/components/admin/invite-dialog';
import { PendingInvites } from '@/components/admin/pending-invites';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { StaffRecord } from '@/lib/admin/types';

export default function StaffPage() {
  const { staff, currentUserId, isLoading, error, refetch } = useAdminStaff();
  // The current user appears in their own staff list; derive whether they're a
  // super_admin so the UI only offers admin-tier role options to those allowed
  // to assign them. The server is the authoritative guard regardless.
  const canManageAdmins =
    staff.find((m) => m.id === currentUserId)?.role === 'super_admin';
  const {
    invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = useAdminInvites();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<StaffRecord | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

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
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setInviteOpen(true)}>
            <Mail className="mr-2 h-4 w-4" />
            Invite
          </Button>
          <Button onClick={handleAddClick}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add Staff
          </Button>
        </div>
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

      <PendingInvites
        invites={invites}
        isLoading={invitesLoading}
        onRevoked={() => void refetchInvites()}
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={() => void refetchInvites()}
        canInviteAdmins={canManageAdmins}
      />

      <StaffFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={handleSuccess}
        staff={editing}
        isSelf={editing !== null && editing.id === currentUserId}
        canManageAdmins={canManageAdmins}
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
