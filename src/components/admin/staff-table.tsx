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
import { Users, KeyRound } from 'lucide-react';
import { SyncPill } from '@/components/admin/sync-pill';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';

interface StaffTableProps {
  readonly staff: readonly StaffRecord[];
  readonly currentUserId: string | null;
  readonly isLoading: boolean;
  readonly onEdit: (staff: StaffRecord) => void;
  readonly onResetPassword: (staff: StaffRecord) => void;
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
      <Badge variant="outline" className="bg-muted text-foreground border-border">
        Super admin
      </Badge>
    );
  }
  if (role === 'admin') {
    return (
      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
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
}: StaffTableProps) {
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
    <div className="overflow-x-auto">
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
        {staff.map((member) => {
          const isSelf = member.id === currentUserId;
          return (
            <TableRow key={member.id}>
              <TableCell className="font-medium">
                <div className="flex flex-wrap items-center gap-1.5">
                  {member.name}
                  {isSelf && (
                    <span className="text-xs text-muted-foreground">(you)</span>
                  )}
                  {member.isFpSynced && (
                    <SyncPill source="fieldpulse" size="md" />
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div>
                  {member.email}
                  {member.isFpSynced && !member.hasLogin && (
                    <div className="text-xs text-muted-foreground">no local sign-in</div>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <RoleBadge role={member.role} />
              </TableCell>
              <TableCell>
                {member.isActive ? (
                  <Badge variant="outline" className="bg-success-light text-success border-success/30">
                    Active
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
                    Inactive
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(member.createdAt)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onResetPassword(member)}
                  >
                    <KeyRound className="mr-1 size-3.5" />
                    Reset password
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(member)}
                  >
                    Edit
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
  );
}
