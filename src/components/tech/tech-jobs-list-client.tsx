'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { VisitRange } from '@/lib/tech/visit-range';

/** Card-shaped skeleton matching the 3-line job card anatomy. */
function JobCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        {/* Header row: reference number + status badge */}
        <div className="flex items-center justify-between">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-5 w-16 rounded-[3px]" />
        </div>
        {/* Issue type line */}
        <Skeleton className="mt-2 h-3.5 w-40" />
        {/* Address / time line */}
        <Skeleton className="mt-1.5 h-3 w-56" />
      </CardContent>
    </Card>
  );
}

interface Job {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly address: string | null;
  readonly arrivalWindowStart: string | null;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly isLead: boolean;
}

const TABS: ReadonlyArray<{ value: VisitRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];

const EMPTY_COPY: Record<VisitRange, string> = {
  today: 'No visits today.',
  upcoming: 'No upcoming visits.',
  past: 'No past visits in the last 30 days.',
};

export function TechJobsListClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<VisitRange>('today');

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs?range=${range}`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setJobs(body.data.jobs);
        setError(null);
      } else {
        setError('Failed to load jobs');
      }
    } catch {
      setError('Could not connect to server.');
    } finally {
      setIsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <ul className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i}>
            <JobCardSkeleton />
          </li>
        ))}
      </ul>
    );
  } else if (error) {
    content = <p className="text-[15px] text-danger-strong">{error}</p>;
  } else if (jobs.length === 0) {
    content = (
      <p className="py-12 text-center text-[15px] text-muted-foreground">
        {EMPTY_COPY[range]}
      </p>
    );
  } else {
    content = (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.appointmentId}>
          <Link href={`/tech/jobs/${job.id}?visit=${job.appointmentId}`}>
            <Card className="transition-colors active:bg-accent">
              <CardContent className="p-4">
                <div className="flex min-h-6 items-center justify-between gap-2">
                  <span className="font-mono text-[13px] font-medium tabular-nums">
                    {job.referenceNumber}
                    {job.appointmentNumber > 1 && ` · Visit ${job.appointmentNumber}`}
                  </span>
                  {/* raw enum value (no humanize here) — left as-is, so no
                    * uppercase transform: it would render "IN_PROGRESS". */}
                  <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
                    {job.status}
                  </span>
                </div>
                <p className="mt-1.5 text-[15px] font-medium">
                  {job.issueType}
                  {job.isLead && (
                    <span className="ml-2 rounded-[3px] border border-border px-1.5 py-0.5 align-middle text-[11px] font-medium text-muted-foreground">
                      Lead
                    </span>
                  )}
                </p>
                {job.address && (
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {job.address}
                  </p>
                )}
                {job.arrivalWindowStart && (
                  <p className="mt-1 font-mono text-[13px] tabular-nums text-muted-foreground">
                    {new Date(job.arrivalWindowStart).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
    );
  }

  return (
    <div className="space-y-4">
      <SegmentedControl
        aria-label="Visit range"
        options={TABS}
        value={range}
        onChange={(next) => {
          setIsLoading(true);
          setRange(next);
        }}
        className="w-full [&>button]:flex-1 [&>button]:justify-center"
      />
      {content}
    </div>
  );
}
