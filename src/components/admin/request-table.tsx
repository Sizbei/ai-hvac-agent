'use client';

import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import {
  DataTableShell,
  type DataTableColumn,
} from '@/components/admin/ui/data-table-shell';
import { Button } from '@/components/ui/button';
import type { AdminRequest } from '@/lib/admin/types';
import { SyncPill } from '@/components/admin/sync-pill';
import { ClipboardList } from 'lucide-react';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface RequestTableProps {
  readonly requests: readonly AdminRequest[];
  readonly isLoading: boolean;
  readonly onRowClick: (request: AdminRequest) => void;
  /** True when any filter (status/urgency/search/assignedTo) is active. */
  readonly hasActiveFilters?: boolean;
  /** Called when the user clicks "Clear filters" in the empty state. */
  readonly onClearFilters?: () => void;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString();
}

const COLUMNS: ReadonlyArray<DataTableColumn<AdminRequest>> = [
  {
    key: 'reference',
    header: 'Reference #',
    className: 'font-mono text-xs',
    cell: (r) => r.referenceNumber,
  },
  {
    key: 'customer',
    header: 'Customer',
    cell: (r) => r.customerName ?? 'Unknown',
  },
  {
    key: 'issue',
    header: 'Issue',
    cell: (r) => issueTypeLabel(r.issueType),
  },
  {
    key: 'urgency',
    header: 'Urgency',
    cell: (r) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        <UrgencyBadge urgency={r.urgency} />
        {r.isAfterHours && (
          <ContextBadge
            variant="after-hours"
            label="After-hrs"
            title="Arrived after hours"
          />
        )}
        {r.syncedSource && <SyncPill source={r.syncedSource} size="md" />}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => <StatusBadge status={r.status} />,
  },
  {
    key: 'submitted',
    header: 'Submitted',
    className: 'text-muted-foreground',
    cell: (r) => formatDate(r.createdAt),
  },
  {
    key: 'assignedTo',
    header: 'Assigned to',
    cell: (r) => r.assignedToName ?? '—',
  },
];

export function RequestTable({
  requests,
  isLoading,
  onRowClick,
  hasActiveFilters = false,
  onClearFilters,
}: RequestTableProps) {
  return (
    <DataTableShell<AdminRequest>
      columns={COLUMNS}
      rows={requests}
      getRowKey={(r) => r.id}
      isLoading={isLoading}
      onRowClick={onRowClick}
      emptyState={
        <EmptyState
          icon={ClipboardList}
          title={hasActiveFilters ? 'No requests match' : 'No requests yet'}
          description={
            hasActiveFilters
              ? 'Try adjusting the filters or search to see results.'
              : 'Service requests submitted by customers will appear here.'
          }
          action={
            hasActiveFilters && onClearFilters ? (
              <Button variant="outline" size="sm" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
}
