'use client';

import { BUSINESS_TIME_ZONE } from '@/lib/admin/calendar-time';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { EmptyStateAction } from '@/components/admin/ui/empty-state-action';
import { emptyActionFor } from '@/lib/admin/empty-state-actions';
import {
  DataTableShell,
  type DataTableColumn,
} from '@/components/admin/ui/data-table-shell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminRequestListRow } from '@/lib/admin/types';
import { SyncPill } from '@/components/admin/sync-pill';
import { ClipboardList } from 'lucide-react';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface RequestTableProps {
  readonly requests: readonly AdminRequestListRow[];
  readonly isLoading: boolean;
  readonly onRowClick: (request: AdminRequestListRow) => void;
  /** True when any filter (status/urgency/search/assignedTo) is active. */
  readonly hasActiveFilters?: boolean;
  /** Called when the user clicks "Clear filters" in the empty state. */
  readonly onClearFilters?: () => void;
  /** Day-one "New request" action (the page's existing create-dialog opener). */
  readonly onCreate?: () => void;
}

/** Submitted day in business time, like the sheet and calendar (not the viewer's zone). */
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', { timeZone: BUSINESS_TIME_ZONE });
}

const COLUMNS: ReadonlyArray<DataTableColumn<AdminRequestListRow>> = [
  {
    key: 'reference',
    header: 'Reference #',
    className: 'font-mono text-xs',
    cell: (r) => r.referenceNumber,
  },
  {
    key: 'customer',
    header: 'Customer',
    // Capped so a long name or imported issue code can't push Status and
    // Assigned off the right edge at desktop widths.
    className: 'max-w-56 truncate',
    cell: (r) => r.customerName ?? 'Unknown',
  },
  {
    key: 'issue',
    header: 'Issue',
    className: 'max-w-56 truncate',
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

/** Phone layout: one card per request, so status and technician are visible
 * without scrolling a seven-column table sideways. */
function RequestCards({
  requests,
  isLoading,
  onRowClick,
  emptyState,
}: {
  readonly requests: readonly AdminRequestListRow[];
  readonly isLoading: boolean;
  readonly onRowClick: (request: AdminRequestListRow) => void;
  readonly emptyState: React.ReactNode;
}) {
  if (isLoading && requests.length === 0) {
    return (
      <div className="space-y-2" aria-busy="true">
        <span role="status" aria-label="Loading" className="sr-only" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="rounded-lg border border-border-strong bg-surface">{emptyState}</div>
    );
  }
  return (
    <ul className="space-y-2" aria-busy={isLoading}>
      {requests.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onRowClick(r)}
            className="w-full rounded-lg border border-border-strong bg-surface-raised p-3 text-left transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {r.customerName ?? 'Unknown'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {issueTypeLabel(r.issueType)} ·{' '}
                  <span className="font-mono">{r.referenceNumber}</span>
                </p>
              </div>
              <StatusBadge status={r.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <UrgencyBadge urgency={r.urgency} />
              {r.isAfterHours && (
                <ContextBadge variant="after-hours" label="After-hrs" title="Arrived after hours" />
              )}
              {r.syncedSource && <SyncPill source={r.syncedSource} size="md" />}
              <span className="ml-auto truncate">
                {r.assignedToName ?? 'No technician'} · {formatDate(r.createdAt)}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RequestTable({
  requests,
  isLoading,
  onRowClick,
  hasActiveFilters = false,
  onClearFilters,
  onCreate,
}: RequestTableProps) {
  const emptyState = (
    <EmptyState
      icon={ClipboardList}
      title={hasActiveFilters ? 'No requests match' : 'No requests yet'}
      description={
        hasActiveFilters
          ? 'Try adjusting the filters. Search matches reference numbers, like HVAC-1A2B or 1A2B.'
          : 'Service requests submitted by customers will appear here.'
      }
      action={
        hasActiveFilters ? (
          onClearFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : undefined
        ) : (
          <EmptyStateAction
            action={emptyActionFor('requests', { hasActiveFilters })}
            onCallback={onCreate}
          />
        )
      }
    />
  );
  return (
    <>
      <div className="sm:hidden">
        <RequestCards
          requests={requests}
          isLoading={isLoading}
          onRowClick={onRowClick}
          emptyState={emptyState}
        />
      </div>
      <DataTableShell<AdminRequestListRow>
        className="hidden sm:flex"
        columns={COLUMNS}
        rows={requests}
        getRowKey={(r) => r.id}
        isLoading={isLoading}
        onRowClick={onRowClick}
        emptyState={emptyState}
      />
    </>
  );
}
