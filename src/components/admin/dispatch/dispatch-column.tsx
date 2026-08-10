'use client';

import { User, Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { BUSINESS_TIME_ZONE } from '@/lib/admin/calendar-time';
import type { DashboardRequest } from '@/lib/admin/types';

interface DispatchColumnProps {
  readonly title: string;
  /** True for the unassigned pile, which gets a distinct icon/accent. */
  readonly isUnassigned?: boolean;
  readonly jobs: readonly DashboardRequest[];
  readonly onSelect: (id: string) => void;
}

function formatIssueType(issueType: string): string {
  return issueType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
  return (
    <button
      type="button"
      aria-label={`${job.customerName ?? 'Unknown'} · ${job.referenceNumber}`}
      onClick={() => onSelect(job.id)}
      className="w-full rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium tabular-nums">
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
        {formatIssueType(job.issueType)} ·{' '}
        <span className="font-mono">{job.referenceNumber}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <UrgencyBadge urgency={job.urgency} />
        <StatusBadge status={job.status} />
      </div>
    </button>
  );
}

export function DispatchColumn({
  title,
  isUnassigned = false,
  jobs,
  onSelect,
}: DispatchColumnProps) {
  const Icon = isUnassigned ? Inbox : User;
  return (
    <Card className="flex w-72 shrink-0 flex-col p-3">
      <div className="mb-2 flex items-center gap-2">
        <Icon
          className={
            isUnassigned ? 'h-4 w-4 text-warning' : 'h-4 w-4 text-muted-foreground'
          }
        />
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <span className="ml-auto text-xs text-muted-foreground">{jobs.length}</span>
      </div>

      {jobs.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {isUnassigned ? 'Nothing to place' : 'No jobs'}
        </p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onSelect={onSelect} />
          ))}
        </div>
      )}
    </Card>
  );
}
