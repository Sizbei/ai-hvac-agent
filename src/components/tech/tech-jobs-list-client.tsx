'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { VisitRange } from '@/lib/tech/visit-range';
import { splitTodayJobs } from '@/lib/tech/today-groups';
import { ChevronDown } from 'lucide-react';
import { issueLabel, overdueLabel, visitBadge, visitWhen } from '@/lib/tech/job-display';
import { GuideCard } from '@/components/tech/guide-card';
import { pickTodayFirst, type TodayFirst } from '@/lib/tech/guide-view';
import { dayClockText } from '@/lib/tech/clock-display';
import { READ_ONLY_PREVIEW } from '@/lib/admin/preview-view';
import { useTechReadOnly } from '@/components/tech/tech-read-only-context';

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
  readonly customerName: string | null;
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly isLead: boolean;
  readonly assignmentStatus: string;
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

/** Day clock: a general clock-in with no job attached. */
function ClockButton() {
  const readOnly = useTechReadOnly();
  // undefined = still loading, null = clocked out, string = clock-in instant.
  const [clockInAt, setClockInAt] = useState<string | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tech/time');
        if (cancelled) return;
        const body = await res.json().catch(() => null);
        setClockInAt(res.ok && body?.data?.clockInAt ? String(body.data.clockInAt) : null);
      } catch {
        if (!cancelled) setClockInAt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!clockInAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clockInAt]);

  async function toggle(): Promise<void> {
    const action = clockInAt ? 'out' : 'in';
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/tech/time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setClockInAt(action === 'in' ? new Date().toISOString() : null);
      } else if (res.status === 409 && action === 'in') {
        // Already clocked in elsewhere: pick up the real start time.
        const cur = await fetch('/api/tech/time');
        const body = cur.ok ? await cur.json().catch(() => null) : null;
        setClockInAt(body?.data?.clockInAt ? String(body.data.clockInAt) : new Date().toISOString());
      } else if (res.status === 404 && action === 'out') {
        setClockInAt(null);
      } else {
        setError(action === 'in' ? "Couldn't clock in. Please try again." : "Couldn't clock out. Please try again.");
      }
    } catch {
      setError(action === 'in' ? "Couldn't clock in. Please try again." : "Couldn't clock out. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const clockedIn = typeof clockInAt === 'string';
  const text = dayClockText({ clockInAt, nowMs: now, pending });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {text.running && (
          <span className="text-[15px] tabular-nums text-muted-foreground" aria-live="off">
            {text.running}
          </span>
        )}
        <span title={readOnly ? READ_ONLY_PREVIEW : undefined}>
          <Button
            type="button"
            size="sm"
            variant={clockedIn ? 'outline' : 'default'}
            disabled={pending || clockInAt === undefined || readOnly}
            onClick={() => void toggle()}
            className="min-h-11"
          >
            {text.button}
          </Button>
        </span>
      </div>
      {error && <p className="text-[13px] text-danger-strong">{error}</p>}
    </div>
  );
}

/** One visit card. `showOverdue` is off inside the Older open jobs group, where every row is old. */
function JobCard({ job, now, showOverdue }: { readonly job: Job; readonly now: Date; readonly showOverdue: boolean }) {
  const when = visitWhen(job.arrivalWindowStart ?? job.scheduledDate, now);
  const overdue = showOverdue
    ? overdueLabel(job.scheduledDate ?? job.arrivalWindowStart, job.assignmentStatus, job.status, now)
    : null;
  return (
    <Link href={`/tech/jobs/${job.id}?visit=${job.appointmentId}`}>
      <Card className="transition-colors active:bg-accent">
        <CardContent className="p-4">
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="font-mono text-[13px] font-medium tabular-nums">
              {job.referenceNumber}
              {job.appointmentNumber > 1 && ` · Visit ${job.appointmentNumber}`}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {overdue && (
                <span className="rounded-[3px] border border-warning-border bg-warning-light px-2 py-0.5 text-[11px] font-medium text-warning-strong">
                  {overdue}
                </span>
              )}
              <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
                {visitBadge(job.assignmentStatus, job.status)}
              </span>
            </span>
          </div>
          {/* Imported titles are shown as typed (caps, emoji): clamp and wrap so they can't break the card. */}
          <p className="mt-1.5 line-clamp-3 text-[15px] font-medium [overflow-wrap:anywhere]">
            {issueLabel(job.issueType)}
            {job.isLead && (
              <span className="ml-2 rounded-[3px] border border-border px-1.5 py-0.5 align-middle text-[11px] font-medium text-muted-foreground">
                Lead
              </span>
            )}
          </p>
          {job.customerName && (
            <p className="mt-1 text-[13px] font-medium [overflow-wrap:anywhere]">
              {job.customerName}
            </p>
          )}
          {job.address && (
            <p className="mt-1 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
              {job.address}
            </p>
          )}
          {when && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              {when}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function JobList({ jobs, now, showOverdue }: { readonly jobs: readonly Job[]; readonly now: Date; readonly showOverdue: boolean }) {
  return (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.appointmentId}>
          <JobCard job={job} now={now} showOverdue={showOverdue} />
        </li>
      ))}
    </ul>
  );
}

/** Collapsed by default: old open visits stay reachable without crowding today's work. */
function OlderJobs({ jobs, now }: { readonly jobs: readonly Job[]; readonly now: Date }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="older-open-jobs"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between rounded-md border border-border bg-surface-raised px-4 text-left text-[15px] font-medium"
      >
        <span>
          Older open jobs <span className="tabular-nums text-muted-foreground">({jobs.length})</span>
        </span>
        <ChevronDown aria-hidden className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div id="older-open-jobs" className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Scheduled more than a week ago and not closed yet. Ask the office if one is already done.
          </p>
          <JobList jobs={jobs} now={now} showOverdue={false} />
        </div>
      ) : null}
    </section>
  );
}

export function TechJobsListClient({ guideHidden }: { readonly guideHidden: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<VisitRange>('today');
  // Guide card inputs (spec §6): the first Today row is captured once, from the
  // first successful Today fetch only; `todaySettled` flips on success, failure
  // or abort so the card never waits for the whole visit. A tab switch never
  // changes either.
  const [todayFirst, setTodayFirst] = useState<TodayFirst>('unknown');
  const [todaySettled, setTodaySettled] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  // Fixed per page load: dates and the overdue cut read against it.
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const isToday = range === 'today';
    void (async () => {
      try {
        const res = await fetch(`/api/tech/jobs?range=${range}`, { signal: controller.signal });
        const body = await res.json().catch(() => ({ success: false }));
        if (cancelled) return;
        if (res.ok && body.success) {
          setJobs(body.data.jobs);
          setError(null);
          if (isToday) {
            setTodayFirst((prev) => {
              if (prev !== 'unknown') return prev;
              // The guide's "Open the job" points at today's work before an old open job.
              const { current, older } = splitTodayJobs(body.data.jobs as Job[], now);
              return pickTodayFirst(current.length > 0 ? current : older);
            });
          }
        } else {
          setError('Failed to load jobs');
        }
      } catch {
        if (cancelled) return;
        setError('Could not connect to server.');
      }
      if (!cancelled) {
        setIsLoading(false);
        if (isToday) setTodaySettled(true);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [range, now]);

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
  } else if (range === 'today') {
    const { current, older } = splitTodayJobs(jobs, now);
    content = (
      <div className="space-y-4">
        {current.length > 0 ? (
          <JobList jobs={current} now={now} showOverdue />
        ) : (
          <p className="py-12 text-center text-[15px] text-muted-foreground">{EMPTY_COPY.today}</p>
        )}
        {older.length > 0 && <OlderJobs jobs={older} now={now} />}
      </div>
    );
  } else if (jobs.length === 0) {
    content = (
      <p className="py-12 text-center text-[15px] text-muted-foreground">
        {EMPTY_COPY[range]}
      </p>
    );
  } else {
    content = <JobList jobs={jobs} now={now} showOverdue />;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ClockButton />
      </div>
      {!guideHidden && (
        <GuideCard
          todayFirst={todayFirst}
          todaySettled={todaySettled}
          onHidden={() => groupRef.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]')?.focus()}
        />
      )}
      <div ref={groupRef}>
        <SegmentedControl
          aria-label="Visit range"
          options={TABS}
          value={range}
          onChange={(next) => {
            if (next === range) return;
            // The first range is always Today, so any switch means that fetch finished or was aborted.
            setTodaySettled(true);
            setIsLoading(true);
            setRange(next);
          }}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
      </div>
      {content}
    </div>
  );
}
