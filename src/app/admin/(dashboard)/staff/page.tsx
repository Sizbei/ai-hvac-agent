'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { UserPlus, Mail, AlertCircle, Users, Check } from 'lucide-react';
import { useAdminStaff } from '@/hooks/use-admin-staff';
import { useAdminInvites } from '@/hooks/use-admin-invites';
import { StaffTable } from '@/components/admin/staff-table';
import { StaffFormDialog } from '@/components/admin/staff-form-dialog';
import { StaffResetPasswordDialog } from '@/components/admin/staff-reset-password-dialog';
import { TimesheetsDialog } from '@/components/admin/timesheets-dialog';
import { TimeOffDialog } from '@/components/admin/staff/time-off-dialog';
import { InviteDialog } from '@/components/admin/invite-dialog';
import { PendingInvites } from '@/components/admin/pending-invites';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { StaffRecord } from '@/lib/admin/types';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionDivider } from '@/components/admin/ui/section-divider';
import { BackToGuideBanner } from '@/components/admin/setup/back-to-guide-banner';
import { useOpenFromParam } from '@/hooks/use-open-from-param';
import { refreshOnboarding } from '@/lib/admin/onboarding-store';
import type { BannerEvent } from '@/lib/admin/setup-card-view';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { SEAT_LIMIT_COPY, seatsFull, seatUsageCopy } from '@/lib/admin/seat-usage';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

const STAFF_OPEN_VALUES = ['technician', 'invite'] as const;

export default function StaffPage() {
  useAdminPageTitle('Staff');
  const { staff, currentUserId, seats, isLoading, error, refetch } = useAdminStaff();
  // Same rule the server applies to invites and direct creation.
  const noFreeSeats = seats !== null && seatsFull(seats);
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
  const [timeOffTarget, setTimeOffTarget] = useState<StaffRecord | null>(null);
  const [timesheetsTarget, setTimesheetsTarget] = useState<StaffRecord | null>(null);
  const [bannerEvent, setBannerEvent] = useState<BannerEvent>(null);
  // Confirmation after a dialog closes ("Password reset for Dana.").
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { fromSetup } = useOpenFromParam('new', STAFF_OPEN_VALUES, (v) => {
    if (v === 'technician') handleAddClick();
    else setInviteOpen(true);
  });

  function noteSetupEvent(event: Exclude<BannerEvent, null>): void {
    if (!fromSetup) return;
    setBannerEvent(event);
    void refreshOnboarding({ force: true });
  }

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

  function showNotice(message: string): void {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }

  function handleSuccess(): void {
    void refetch();
    noteSetupEvent('saved');
  }

  function handleFormSuccess(): void {
    showNotice(editing ? `Saved changes to ${editing.name}.` : 'Staff member added.');
    handleSuccess();
  }

  function handleResetSuccess(): void {
    if (resetTarget) showNotice(`Password reset for ${resetTarget.name}.`);
    void refetch();
  }

  function handleInviteSuccess(role: 'admin' | 'technician'): void {
    void refetchInvites();
    if (role === 'technician') noteSetupEvent('invite');
  }

  return (
    <PageShell>
      <PageHeader
        title="Staff"
        subtitle="Manage admins and technicians, roles, and passwords."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setInviteOpen(true)}
              disabled={noFreeSeats}
            >
              <Mail className="mr-2 h-4 w-4" />
              Invite
            </Button>
            <Button onClick={handleAddClick} disabled={noFreeSeats}>
              <UserPlus className="mr-2 h-4 w-4" />
              Add staff
            </Button>
          </>
        }
      />

      {fromSetup && <BackToGuideBanner stepId="add_technician" event={bannerEvent} />}

      {seats && (
        <InfoBanner icon={Users}>
          {seatUsageCopy(seats)}
          {noFreeSeats && (
            <>
              {' '}
              {SEAT_LIMIT_COPY}
              {canManageAdmins && (
                <>
                  {' '}
                  <Link href="/admin/settings/billing" className="font-medium underline underline-offset-2">
                    See plans
                  </Link>
                </>
              )}
            </>
          )}
        </InfoBanner>
      )}

      {notice && (
        <p role="status" className="flex items-center gap-2 text-sm text-success-strong">
          <Check className="size-4" aria-hidden="true" />
          {notice}
        </p>
      )}

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
        onTimeOff={setTimeOffTarget}
        onTimesheets={setTimesheetsTarget}
      />

      <SectionDivider label="Pending invites" />

      <PendingInvites
        invites={invites}
        isLoading={invitesLoading}
        onRevoked={() => void refetchInvites()}
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={handleInviteSuccess}
        canInviteAdmins={canManageAdmins}
      />

      <StaffFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={handleFormSuccess}
        staff={editing}
        isSelf={editing !== null && editing.id === currentUserId}
        canManageAdmins={canManageAdmins}
      />

      <StaffResetPasswordDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onSuccess={handleResetSuccess}
        staff={resetTarget}
      />
      <TimesheetsDialog
        open={timesheetsTarget !== null}
        onClose={() => setTimesheetsTarget(null)}
        staff={timesheetsTarget}
      />
      <TimeOffDialog
        open={timeOffTarget !== null}
        onClose={() => setTimeOffTarget(null)}
        staff={timeOffTarget}
      />
    </PageShell>
  );
}
