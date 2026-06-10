'use client';

import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { formatBusinessTime } from '@/lib/admin/calendar-time';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import type { DashboardRequest } from '@/lib/admin/types';

interface CalendarJobCardProps {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  /** Compact variant for the dense week grid — hides secondary metadata. */
  readonly compact?: boolean;
}

function formatIssueType(issueType: string): string {
  return issueType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * A single job card on the calendar grid. Positioned absolutely by its parent
 * lane (top/height from placeJobInGrid); here we only render content. Times are
 * shown in the business timezone via formatBusinessTime, never the viewer's.
 *
 * Structure is @dnd-kit-ready: a self-contained button keyed by job.id. S3 wraps
 * this in a useDraggable node — the markup needs no change for that.
 */
export function CalendarJobCard({ job, onSelect, compact }: CalendarJobCardProps) {
  const start = job.arrivalWindowStart ? new Date(job.arrivalWindowStart) : null;
  const time = start && !Number.isNaN(start.getTime())
    ? formatBusinessTime(start)
    : '—';

  const accent = urgencyAccent(job.urgency);

  return (
    <button
      type="button"
      onClick={() => onSelect(job.id)}
      // Sky body + an urgency-colored left rail (border-l-4) so a glance reads
      // priority by color — consistent with the urgency badges.
      className={`flex h-full w-full flex-col overflow-hidden rounded-md border border-l-4 border-sky-200 ${accent.bar} bg-sky-50 px-2 py-1 text-left text-xs leading-tight transition-colors hover:bg-sky-100 dark:border-sky-900 dark:bg-sky-950 dark:hover:bg-sky-900`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="font-medium tabular-nums">{time}</span>
        {job.isAfterHours && (
          <span
            title="After hours"
            className="inline-flex shrink-0 items-center rounded-full border border-amber-300 bg-amber-100 px-1 text-[9px] font-medium text-amber-800"
          >
            AH
          </span>
        )}
      </div>
      <span className="truncate font-medium text-foreground">
        {job.customerName ?? 'Unknown'}
      </span>
      {!compact && (
        <>
          <span className="truncate text-[11px] text-muted-foreground">
            {formatIssueType(job.issueType)} ·{' '}
            <span className="font-mono">{job.referenceNumber}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <UrgencyBadge urgency={job.urgency} />
            <StatusBadge status={job.status} />
          </span>
        </>
      )}
    </button>
  );
}
