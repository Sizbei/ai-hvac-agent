'use client';

import Link from 'next/link';
import { User, Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { BUSINESS_TIME_ZONE } from '@/lib/admin/calendar-time';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import type { DashboardRequest } from '@/lib/admin/types';
import { issueTypeLabel } from '@/lib/admin/request-labels';
import { EMPTY_LANE_COPY, UNASSIGNED_EMPTY_COPY, unscheduledLinkLabel } from '@/lib/admin/dispatch-empty';

interface DispatchColumnProps {
  readonly title: string;
  /** True for the unassigned pile, which gets a distinct icon/accent. */
  readonly isUnassigned?: boolean;
  readonly jobs: readonly DashboardRequest[];
  readonly onSelect: (id: string) => void;
  /** Open requests not yet placed; links the empty unassigned pile to the calendar. */
  readonly unscheduledCount?: number;
}

/**
 * Format an ISO arrival-window instant as a business-timezone clock label,
 * e.g. "2:00 PM". The board is bucketed by the BUSINESS (Eastern) day
 * (`businessIsoDate`, see calendar-time.ts), so the card's time must render
 * in the same zone — never UTC, which reads 4-5h off depending on DST.
 */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  // Locale pinned to en-US (not the viewer's host locale) so the format is
  // deterministic — matches the convention in calendar-time.ts's
  // formatBusinessTime.
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: BUSINESS_TIME_ZONE,
  });
}

function JobCard({
  job,
  onSelect,
}: {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
}) {
  // A visit a hold ended stays visible where it was, but reads as ended.
  const ended = job.visitEnded === true;
  const visitTag = ended ? 'Visit ended' : job.visitNumber ? `Visit #${job.visitNumber}` : null;
  return (
    <button
      type="button"
      aria-label={`${job.customerName ?? 'Unknown'} · ${job.referenceNumber}${visitTag ? ` · ${visitTag}` : ''}`}
      onClick={() => onSelect(job.id)}
      className={`w-full rounded-sm border border-l-2 px-3 py-2 text-left transition-colors hover:bg-row-hover ${urgencyAccent(job.urgency).bar} ${
        ended ? 'border-dashed border-border-strong bg-surface-sunken text-muted-foreground' : 'border-border bg-surface-raised'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-medium tabular-nums${ended ? ' line-through' : ''}`}>
          {formatTime(job.arrivalWindowStart)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {job.autoAssigned && (
            <ContextBadge
              variant="auto"
              label="Auto"
              title="Auto-assigned by smart dispatch"
            />
          )}
          {job.isAfterHours && (
            <ContextBadge
              variant="after-hours"
              label="After-hrs"
              title="After hours"
            />
          )}
        </div>
      </div>
      <div className="mt-0.5 truncate text-sm">{job.customerName ?? 'Unknown'}</div>
      <div className="truncate text-xs text-muted-foreground">
        {issueTypeLabel(job.issueType)} ·{' '}
        <span className="font-mono">{job.referenceNumber}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <UrgencyBadge urgency={job.urgency} />
        <StatusBadge status={job.status} />
        {visitTag && (
          <span className="text-xs font-medium text-muted-foreground">{visitTag}</span>
        )}
      </div>
    </button>
  );
}

export function DispatchColumn({
  title,
  isUnassigned = false,
  jobs,
  onSelect,
  unscheduledCount = 0,
}: DispatchColumnProps) {
  const unscheduledLink = isUnassigned ? unscheduledLinkLabel(unscheduledCount) : null;
  const Icon = isUnassigned ? Inbox : User;
  return (
    <Card className="flex w-72 shrink-0 flex-col p-0">
      <div className="flex h-10 items-center gap-2 border-b border-border-strong bg-surface-sunken px-3 shadow-[var(--keyline-top)]">
        <Icon
          className={
            isUnassigned
              ? 'h-4 w-4 text-warning-strong'
              : 'h-4 w-4 text-foreground-faint'
          }
        />
        <h2 className="truncate text-[15px] font-semibold">{title}</h2>
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {jobs.filter((j) => !j.visitEnded).length}
        </span>
      </div>

      {jobs.length === 0 ? (
        <div className="space-y-1 py-8 text-center text-xs text-muted-foreground">
          <p>{isUnassigned ? UNASSIGNED_EMPTY_COPY : EMPTY_LANE_COPY}</p>
          {unscheduledLink && (
            <p>
              <Link href="/admin/calendar" className="font-medium text-primary underline-offset-2 hover:underline">
                {unscheduledLink}
              </Link>
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2 p-3">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onSelect={onSelect} />
          ))}
        </div>
      )}
    </Card>
  );
}
