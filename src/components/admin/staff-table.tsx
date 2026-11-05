'use client';

import type { StaffRecord } from '@/lib/admin/types';
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
import { Users, KeyRound, CalendarOff, Clock } from 'lucide-react';
import { SyncPill } from '@/components/admin/sync-pill';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';

interface StaffTableProps {
  readonly staff: readonly StaffRecord[];
  readonly currentUserId: string | null;
  readonly isLoading: boolean;
  readonly onEdit: (staff: StaffRecord) => void;
  readonly onResetPassword: (staff: StaffRecord) => void;
  readonly onTimeOff: (staff: StaffRecord) => void;
  readonly onTimesheets: (staff: StaffRecord) => void;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Role badge with semantic token colors — no raw palette classes. */
function RoleBadge({ role }: { role: StaffRecord['role'] }) {
  if (role === 'super_admin') {
    return (
      <Badge variant="outline" className="bg-marker-light text-marker-strong border-marker-border">
        Super admin
      </Badge>
    );
  }
  if (role === 'admin') {
    return (
      <Badge variant="outline" className="bg-surface-raised text-muted-foreground border-border-strong">
        Admin
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
      Technician
    </Badge>
  );
}

export function StaffTable({
  staff,
  currentUserId,
  isLoading,
  onEdit,
  onResetPassword,
  onTimeOff,
  onTimesheets,
}: StaffTableProps) {
  const actions: ActionHandlers = { onEdit, onResetPassword, onTimeOff, onTimesheets };

  if (isLoading) {
    return <SkeletonTable rows={4} cols={6} />;
  }

  if (staff.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Invite your first teammate"
        description="Use the Invite button above to send a link, or Add staff to create a sign-in directly."
      />
    );
  }

  return (
    <>
      {/* Phones: one card per person so role, status and actions stay visible. */}
      <ul className="space-y-3 sm:hidden">
        {staff.map((member) => (
          <li key={member.id} className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <NameCell member={member} isSelf={member.id === currentUserId} />
              <StatusBadge isActive={member.isActive} />
            </div>
            <div className="mt-1 break-all text-sm text-muted-foreground">
              <EmailCell member={member} />
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <RoleBadge role={member.role} />
              <span>Joined {formatDate(member.createdAt)}</span>
            </div>
            <StaffActions
              member={member}
              className="mt-3 flex flex-wrap gap-2"
              {...actions}
            />
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="font-medium">
                  <NameCell member={member} isSelf={member.id === currentUserId} />
                </TableCell>
                <TableCell>
                  <EmailCell member={member} />
                </TableCell>
                <TableCell>
                  <RoleBadge role={member.role} />
                </TableCell>
                <TableCell>
                  <StatusBadge isActive={member.isActive} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(member.createdAt)}
                </TableCell>
                <TableCell>
                  <StaffActions
                    member={member}
                    className="flex justify-end gap-2"
                    {...actions}
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

function NameCell({ member, isSelf }: { readonly member: StaffRecord; readonly isSelf: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-medium">
      {member.name}
      {isSelf && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
      {member.isFpSynced && <SyncPill source="fieldpulse" size="md" />}
    </div>
  );
}

function EmailCell({ member }: { readonly member: StaffRecord }) {
  return (
    <div>
      {member.email}
      {member.isFpSynced && !member.hasLogin && (
        <div className="text-xs text-muted-foreground">no local sign-in</div>
      )}
    </div>
  );
}

function StatusBadge({ isActive }: { readonly isActive: boolean }) {
  return isActive ? (
    <Badge variant="outline" className="bg-success-light text-success-strong border-success-border">
      Active
    </Badge>
  ) : (
    <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
      Inactive
    </Badge>
  );
}

interface ActionHandlers {
  readonly onEdit: (staff: StaffRecord) => void;
  readonly onResetPassword: (staff: StaffRecord) => void;
  readonly onTimeOff: (staff: StaffRecord) => void;
  readonly onTimesheets: (staff: StaffRecord) => void;
}

/** Inactive people can't sign in, so only history (Timesheets) and Edit apply. */
function StaffActions({
  member,
  className,
  onEdit,
  onResetPassword,
  onTimeOff,
  onTimesheets,
}: ActionHandlers & { readonly member: StaffRecord; readonly className: string }) {
  const isTechnician = member.role === 'technician';
  return (
    <div className={className}>
      {isTechnician && (
        <Button variant="outline" size="sm" onClick={() => onTimesheets(member)}>
          <Clock className="mr-1 size-3.5" />
          Timesheets
        </Button>
      )}
      {isTechnician && member.isActive && (
        <Button variant="outline" size="sm" onClick={() => onTimeOff(member)}>
          <CalendarOff className="mr-1 size-3.5" />
          Time off
        </Button>
      )}
      {member.isActive && (
        <Button variant="outline" size="sm" onClick={() => onResetPassword(member)}>
          <KeyRound className="mr-1 size-3.5" />
          Reset password
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => onEdit(member)}>
        Edit
      </Button>
    </div>
  );
}
