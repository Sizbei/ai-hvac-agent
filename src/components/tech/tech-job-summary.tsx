'use client';

import { useCallback, useEffect, useState } from 'react';
import { Phone, Navigation, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatArrivalWindow } from '@/lib/admin/arrival-window';

interface TechJobSummary {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly issueType: string;
  readonly systemType: string | null;
  readonly urgency: string;
  readonly description: string | null;
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly address: string | null;
  readonly accessNotes: string | null;
  readonly allowedNextStatuses: readonly string[];
}

function humanize(s: string): string {
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Google Maps turn-by-turn deep link to the service address. */
function directionsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

/**
 * The "all info" header for a tech's job: who/where/what + tap-to-call, tap-to-
 * navigate, and the status-advance controls. Fetches GET /api/tech/jobs/[id].
 * On a status change it refetches itself and calls onStatusChanged so the parent
 * can refresh the timeline.
 */
export function TechJobSummary({
  id,
  onStatusChanged,
}: {
  readonly id: string;
  readonly onStatusChanged?: () => void;
}) {
  const [job, setJob] = useState<TechJobSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setJob(body.data);
        setError(null);
      } else {
        setError("Couldn't load this job.");
      }
    } catch {
      setError("Couldn't load this job.");
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const advance = useCallback(
    async (status: string): Promise<void> => {
      setAdvancing(status);
      setError(null);
      try {
        const res = await fetch(`/api/tech/jobs/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (res.ok) {
          await load();
          onStatusChanged?.();
        } else {
          const body = await res.json().catch(() => ({}));
          setError(body?.error?.message ?? "Couldn't update status.");
        }
      } catch {
        setError('Could not connect to server.');
      } finally {
        setAdvancing(null);
      }
    },
    [id, load, onStatusChanged],
  );

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!job) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-destructive">
          {error ?? "Couldn't load this job."}
        </CardContent>
      </Card>
    );
  }

  const windowLabel = formatArrivalWindow(
    job.arrivalWindowStart,
    job.arrivalWindowEnd,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">
            {job.customerName ?? 'Customer'}
          </CardTitle>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {humanize(job.status)}
          </span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {job.referenceNumber}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Contact + navigate (anchors styled as buttons; Button has no asChild) */}
        <div className="flex flex-wrap gap-2">
          {job.customerPhone && (
            <a
              href={`tel:${job.customerPhone}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium active:bg-muted"
            >
              <Phone className="size-4" /> Call
            </a>
          )}
          {job.address && (
            <a
              href={directionsUrl(job.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium active:bg-muted"
            >
              <Navigation className="size-4" /> Navigate
            </a>
          )}
        </div>

        {job.address && <p className="text-sm">{job.address}</p>}

        {/* What */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
            {humanize(job.issueType)}
          </span>
          {job.systemType && (
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs">
              {humanize(job.systemType)}
            </span>
          )}
          <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {humanize(job.urgency)}
          </span>
        </div>

        {windowLabel && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="size-4" /> {windowLabel}
          </p>
        )}

        {job.description && (
          <p className="whitespace-pre-wrap text-sm">{job.description}</p>
        )}

        {job.accessNotes && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <span className="font-medium">Access: </span>
            {job.accessNotes}
          </p>
        )}

        {/* Advance status */}
        {job.allowedNextStatuses.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {job.allowedNextStatuses.map((s) => (
              <Button
                key={s}
                size="sm"
                disabled={advancing !== null}
                onClick={() => void advance(s)}
              >
                {advancing === s ? 'Saving…' : humanize(s)}
              </Button>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
