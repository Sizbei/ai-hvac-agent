'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import type { AdminRequest } from '@/lib/admin/types';

interface RequestTableProps {
  readonly requests: readonly AdminRequest[];
  readonly isLoading: boolean;
  readonly onRowClick: (request: AdminRequest) => void;
}

function formatIssueType(issueType: string): string {
  return issueType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString();
}

const SKELETON_ROWS = 5;
const COLUMN_COUNT = 7;

export function RequestTable({ requests, isLoading, onRowClick }: RequestTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Reference #</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Issue</TableHead>
          <TableHead>Urgency</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Assigned To</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading
          ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {Array.from({ length: COLUMN_COUNT }, (__, j) => (
                  <TableCell key={`skeleton-cell-${i}-${j}`}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : requests.length === 0
            ? (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="text-center py-8 text-muted-foreground">
                    No requests found
                  </TableCell>
                </TableRow>
              )
            : requests.map((request) => (
                <TableRow
                  key={request.id}
                  className="cursor-pointer"
                  onClick={() => onRowClick(request)}
                >
                  <TableCell className="font-mono text-xs">
                    {request.referenceNumber}
                  </TableCell>
                  <TableCell>{request.customerName ?? 'Unknown'}</TableCell>
                  <TableCell>{formatIssueType(request.issueType)}</TableCell>
                  <TableCell>
                    <UrgencyBadge urgency={request.urgency} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={request.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(request.createdAt)}
                  </TableCell>
                  <TableCell>{request.assignedToName ?? '—'}</TableCell>
                </TableRow>
              ))}
      </TableBody>
    </Table>
  );
}
