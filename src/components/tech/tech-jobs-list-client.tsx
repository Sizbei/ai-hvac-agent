'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { VisitRange } from '@/lib/tech/visit-range';
import { labelAssignmentStatus } from '@/components/tech/tech-status-confirm';
import { GuideCard } from '@/components/tech/guide-card';
import { pickTodayFirst, type TodayFirst } from '@/lib/tech/guide-view';

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

/** 3725 seconds -> "1:02:05"; under an hour -> "2:05". */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(h > 0 ? 2 : 1, '0');
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

/** Day clock: a general clock-in with no job attached. */
function ClockButton() {
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
        if (res.status === 404) {
          setClockInAt(null);
          return;
        }
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
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {clockedIn && (
          <span className="font-mono text-[15px] tabular-nums text-muted-foreground" aria-live="off">
            {formatElapsed(now - new Date(clockInAt).getTime())}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant={clockedIn ? 'outline' : 'default'}
          disabled={pending || clockInAt === undefined}
          onClick={() => void toggle()}
          className="min-h-11"
        >
          {pending ? (clockedIn ? 'Clocking out…' : 'Clocking in…') : clockedIn ? 'Clock out' : 'Clock in'}
        </Button>
      </div>
      {error && <p className="text-[13px] text-danger-strong">{error}</p>}
    </div>
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

  useEffect(() => {
    let cancelled = false;
    let settled = false;
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
            setTodayFirst((prev) => (prev === 'unknown' ? pickTodayFirst(body.data.jobs) : prev));
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
        if (isToday) {
          settled = true;
          setTodaySettled(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      // An aborted Today fetch still settles the card (todayFirst stays 'unknown').
      if (isToday && !settled) setTodaySettled(true);
    };
  }, [range]);

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
                  <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
                    {labelAssignmentStatus(job.assignmentStatus)}
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
