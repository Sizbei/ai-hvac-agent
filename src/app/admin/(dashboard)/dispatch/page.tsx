'use client';

import { useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react';
import { useDispatchBoard } from '@/hooks/use-dispatch-board';
import { DispatchColumn } from '@/components/admin/dispatch/dispatch-column';
import { busyColumnsFirst } from '@/lib/admin/dispatch-board-order';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { EmptyStateAction } from '@/components/admin/ui/empty-state-action';
import { emptyActionFor } from '@/lib/admin/empty-state-actions';
import { UrgencyLegend } from '@/components/admin/ui/urgency-legend';
import { businessIsoDate } from '@/lib/admin/calendar-time';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

/** Current BUSINESS day as YYYY-MM-DD. Anchoring on the UTC day put the board
 * on tomorrow every evening after 8pm ET; the server buckets jobs by business
 * day too (getDispatchBoard), so picker and query agree. */
function todayBusiness(): string {
  return businessIsoDate(new Date());
}

/** Shift an ISO date (YYYY-MM-DD) by whole days, staying in UTC. */
function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Human-readable labels for the queued auto-dispatch outcomes. Replaces the
 *  buggy non-global `.replace('_',' ')` that only stripped the first underscore. */
const OUTCOME_LABELS: Record<string, string> = {
  queued_no_capacity: 'no capacity',
  queued_low_confidence: 'low confidence',
  queued_after_hours: 'after hours',
  queued_no_match: 'no match',
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/^queued_/, '').replace(/_/g, ' ');
}

function formatDayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function DispatchPage() {
  useAdminPageTitle('Dispatch');
  const [date, setDate] = useState<string>(todayBusiness);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const { board, isLoading, error, refetch } = useDispatchBoard(date);

  const isToday = date === todayBusiness();

  return (
    <PageShell>
      <PageHeader
        title="Dispatch"
        subtitle="Scheduled requests by technician for the day."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setDate((d) => shiftDate(d, -1))}
              aria-label="Previous day"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="min-w-32 text-center font-mono text-[13px] font-medium tabular-nums">
              {formatDayLabel(date)}
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setDate((d) => shiftDate(d, 1))}
              aria-label="Next day"
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant={isToday ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setDate(todayBusiness())}
              disabled={isToday}
            >
              Today
            </Button>
          </div>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Retry loading dispatch board"
              onClick={() => void refetch()}
            >
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {board && board.exceptions.length > 0 && (
        <Card className="p-4">
          <SectionHeading
            title="Exceptions"
            description="Queued requests needing a decision."
            className="mb-3"
          />
          <ul className="space-y-1.5">
            {board.exceptions.map((ex) => (
              <li key={ex.id}>
                {/* Exception row: 2px status left edge, body stays --surface. */}
                <button
                  type="button"
                  onClick={() => setSelectedRequestId(ex.id)}
                  className="flex w-full items-center gap-2 rounded-sm border border-border border-l-2 border-l-warning bg-surface px-3 py-2 text-left text-[13px] transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono font-medium">{ex.referenceNumber}</span>
                  <span className="text-muted-foreground">{ex.issueType}</span>
                  <ContextBadge
                    variant="warning"
                    label={outcomeLabel(ex.autoDispatchOutcome)}
                  />
                  <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDayLabel(ex.createdAt.slice(0, 10))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isLoading && !board ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={`col-skeleton-${i}`} className="flex w-72 shrink-0 flex-col gap-0 p-0">
              {/* Sunken 40px column header band + keyline, matching the real column */}
              <div className="flex h-10 items-center gap-2 border-b border-border-strong bg-surface-sunken px-3 shadow-[var(--keyline-top)]">
                <Skeleton className="size-4 shrink-0" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-4" />
              </div>
              {/* Stacked job-card bars */}
              <div className="space-y-2 p-3">
                {Array.from({ length: 3 }, (__, j) => (
                  <div
                    key={j}
                    className="space-y-1.5 rounded-sm border border-border bg-surface-raised px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-8" />
                    </div>
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-44" />
                    <div className="flex gap-1.5 pt-0.5">
                      <Skeleton className="h-4 w-12" />
                      <Skeleton className="h-4 w-14" />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : !isLoading && !board && error ? null : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          <DispatchColumn
            title="Unassigned"
            isUnassigned
            jobs={board?.unassigned ?? []}
            onSelect={setSelectedRequestId}
          />
          {busyColumnsFirst(board?.columns ?? []).map((column) => (
            <DispatchColumn
              key={column.technicianId}
              title={column.technicianName}
              jobs={column.jobs}
              onSelect={setSelectedRequestId}
            />
          ))}
          {board && board.columns.length === 0 && (
            <EmptyState
              icon={Users}
              title="No active technicians"
              description="Add technicians under Staff to start dispatching jobs."
              className="mx-auto"
              action={
                <EmptyStateAction
                  action={emptyActionFor('dispatch', { hasActiveFilters: false })}
                />
              }
            />
          )}
        </div>
      )}

      <UrgencyLegend />

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </PageShell>
  );
}
