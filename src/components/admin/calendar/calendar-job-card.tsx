'use client';

import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { formatBusinessTimeRange, shortBusinessTime } from '@/lib/admin/calendar-time';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import type { DashboardRequest } from '@/lib/admin/types';
import { SyncPill } from '@/components/admin/sync-pill';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface CalendarJobCardProps {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  /** Compact variant for the dense week grid — hides secondary metadata. */
  readonly compact?: boolean;
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
  const end = job.arrivalWindowEnd ? new Date(job.arrivalWindowEnd) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
  const validEnd = end && !Number.isNaN(end.getTime()) ? end : null;
  // The whole window ("8 AM–12 PM"), not just its start.
  const time = validStart
    ? validEnd
      ? formatBusinessTimeRange(validStart, validEnd)
      : shortBusinessTime(validStart)
    : '—';

  const accent = urgencyAccent(job.urgency);
  // A visit a hold ended: shown where it was, clearly not live.
  const ended = job.visitEnded === true;
  const visitTag = ended ? 'Visit ended' : job.visitNumber ? `Visit #${job.visitNumber}` : null;

  return (
    <button
      type="button"
      aria-label={`${job.customerName ?? 'Unknown'} · ${job.referenceNumber}${visitTag ? ` · ${visitTag}` : ''}`}
      onClick={() => onSelect(job.id)}
      // Raised (white = a record) body, hairline border, and a 3px urgency
      // left rail so a glance reads priority by color — same semantic families
      // as the urgency badges.
      className={`flex h-full w-full flex-col overflow-hidden rounded-sm border border-l-[3px] ${accent.bar} px-2 py-1 text-left text-xs leading-tight transition-colors hover:bg-row-hover ${
        ended ? 'border-dashed border-border-strong bg-surface-sunken text-muted-foreground' : 'border-border bg-surface-raised'
      }`}
    >
      <div className="flex shrink-0 items-center gap-1">
        <span className={`truncate font-mono font-medium tabular-nums${ended ? ' line-through' : ''}`}>{time}</span>
        {job.isAfterHours && (
          <span
            title="After hours"
            className="inline-flex shrink-0 items-center rounded-[3px] border border-warning-border bg-warning-light px-1 text-[9px] font-medium text-warning-strong"
          >
            AH
          </span>
        )}
        {job.syncedSource && (
          // ml-auto keeps the pill right-anchored in the chip row (pre-SyncPill layout).
          <span className="ml-auto flex shrink-0">
            <SyncPill source={job.syncedSource} size="sm" />
          </span>
        )}
      </div>
      {/* shrink-0: on a short card the customer outranks the badges. */}
      <span className={`shrink-0 truncate font-medium ${ended ? 'text-muted-foreground' : 'text-foreground'}`}>
        {job.customerName ?? 'Unknown'}
      </span>
      {visitTag && (
        <span className="shrink-0 truncate text-[11px] font-medium leading-[14px] text-muted-foreground">
          {visitTag}
        </span>
      )}
      {!compact && (
        <>
          <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
            {issueTypeLabel(job.issueType)} ·{' '}
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
