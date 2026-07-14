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
import { Skeleton } from '@/components/ui/skeleton';
import { KeyRound } from 'lucide-react';
import { SyncPill } from '@/components/admin/sync-pill';

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

function RoleBadge({ role }: { role: StaffRecord['role'] }) {
  if (role === 'super_admin') {
    return (
      <Badge className="bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
        Super Admin
      </Badge>
    );
  }
  if (role === 'admin') {
    return (
      <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
        Admin
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
      Technician
    </Badge>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 4 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-44" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-7 w-32" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function StaffTable({
  staff,
  currentUserId,
  isLoading,
  onEdit,
  onResetPassword,
}: StaffTableProps) {
  if (!isLoading && staff.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No staff found.
      </div>
    );
  }

  return (
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
        {isLoading ? (
          <SkeletonRows />
        ) : (
          staff.map((member) => {
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
                      <div className="text-xs text-muted-foreground">no local login</div>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <RoleBadge role={member.role} />
                </TableCell>
                <TableCell>
                  {member.isActive ? (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
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
                      Reset
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
          })
        )}
      </TableBody>
    </Table>
  );
}
