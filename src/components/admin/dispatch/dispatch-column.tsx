'use client';

import { User, Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
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

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
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
            <span
              title="Auto-assigned by smart dispatch"
              className="inline-flex items-center rounded-full border border-sky-300 bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800"
            >
              Auto
            </span>
          )}
          {job.isAfterHours && (
            <span
              title="After hours"
              className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
            >
              After-hrs
            </span>
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
            isUnassigned
              ? 'h-4 w-4 text-amber-600 dark:text-amber-400'
              : 'h-4 w-4 text-muted-foreground'
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
