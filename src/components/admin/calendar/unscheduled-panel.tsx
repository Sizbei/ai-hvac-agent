'use client';

import { Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import { DASHBOARD_LIST_LIMIT, type DashboardRequest } from '@/lib/admin/types';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface UnscheduledPanelProps {
  /** Jobs not yet placed: no technician and/or no arrival window. */
  readonly jobs: readonly DashboardRequest[];
  readonly isLoading: boolean;
  readonly onSelect: (id: string) => void;
}

function reason(job: DashboardRequest): string {
  const noTech = !job.assignedToName;
  const noWindow = !job.arrivalWindowStart;
  if (noTech && noWindow) return 'No technician · no window';
  if (noTech) return 'No technician';
  return 'No arrival window';
}

/**
 * The "to place" queue beside the calendar: open jobs missing a technician
 * and/or an arrival window. The job cards are @dnd-kit-ready (self-contained,
 * keyed by id) so S3 can make them draggable onto a calendar lane without
 * restructuring. Read-only here.
 */
export function UnscheduledPanel({ jobs, isLoading, onSelect }: UnscheduledPanelProps) {
  return (
    <Card className="flex w-full flex-col p-3 lg:w-72 lg:shrink-0">
      <div className="mb-2 flex items-center gap-2">
        <Inbox className="size-4 text-warning-strong" />
        <h2 className="text-[13px] font-semibold">Unscheduled</h2>
        {!isLoading && (
          <span
            className="ml-auto font-mono text-xs tabular-nums text-muted-foreground"
            title={
              jobs.length >= DASHBOARD_LIST_LIMIT
                ? `Showing the first ${DASHBOARD_LIST_LIMIT}`
                : undefined
            }
          >
            {jobs.length}
            {jobs.length >= DASHBOARD_LIST_LIMIT ? '+' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={`unsched-skeleton-${i}`} className="h-16 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nothing to place.
        </p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onSelect(job.id)}
                className={`w-full rounded-sm border border-border border-l-[3px] ${urgencyAccent(job.urgency).bar} bg-surface-raised px-3 py-2 text-left transition-colors hover:bg-row-hover`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-medium">
                    {job.customerName ?? 'Unknown'}
                  </span>
                  {job.isAfterHours && (
                    <span
                      title="After hours"
                      className="inline-flex shrink-0 items-center rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[10px] font-medium text-warning-strong"
                    >
                      After-hrs
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {issueTypeLabel(job.issueType)} ·{' '}
                  <span className="font-mono">{job.referenceNumber}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <UrgencyBadge urgency={job.urgency} />
                  <StatusBadge status={job.status} />
                  <span className="ml-auto text-[10px] font-medium text-warning-strong">
                    {reason(job)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
