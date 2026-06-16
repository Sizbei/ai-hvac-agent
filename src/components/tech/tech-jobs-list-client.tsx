'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface Job {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly address: string | null;
  readonly arrivalWindowStart: string | null;
}

export function TechJobsListClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/tech/jobs');
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (jobs.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No active jobs assigned to you.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link href={`/tech/jobs/${job.id}`}>
            <Card className="transition-colors active:bg-muted">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {job.referenceNumber}
                  </span>
                  <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">
                    {job.status}
                  </span>
                </div>
                <p className="mt-1 text-sm">{job.issueType}</p>
                {job.address && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {job.address}
                  </p>
                )}
                {job.arrivalWindowStart && (
                  <p className="mt-1 text-xs text-muted-foreground">
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
