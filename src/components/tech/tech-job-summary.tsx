'use client';

import { useCallback, useEffect, useState } from 'react';
import { Phone, Navigation, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatArrivalWindow } from '@/lib/admin/arrival-window';
import { buildStatusConfirmCopy, isTerminalStatus, techStatusLabel } from '@/components/tech/tech-status-confirm';

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
  appointmentId,
  onStatusChanged,
}: {
  readonly id: string;
  readonly appointmentId?: string;
  readonly onStatusChanged?: () => void;
}) {
  const [job, setJob] = useState<TechJobSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState<string | null>(null);
  // Set while a terminal status (cancelled/completed) is awaiting the
  // technician's explicit second confirmation — the POST does not fire until
  // they tap the confirm button. (Rtech-4)
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const query = appointmentId ? `?appointmentId=${encodeURIComponent(appointmentId)}` : '';
      const res = await fetch(`/api/tech/jobs/${id}${query}`);
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
  }, [id, appointmentId]);

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
          body: JSON.stringify(appointmentId ? { status, appointmentId } : { status }),
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
    [id, appointmentId, load, onStatusChanged],
  );

  // Cancelled/completed require an explicit second tap before the POST
  // fires; the other manual targets advance immediately, as before.
  const handleStatusTap = useCallback(
    (status: string): void => {
      if (isTerminalStatus(status)) {
        setPendingConfirm(status);
      } else {
        void advance(status);
      }
    },
    [advance],
  );

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!job) {
    return (
      <Card>
        <CardContent className="py-4 text-[15px] text-danger-strong">
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
          <CardTitle className="text-[17px]">
            {job.customerName ?? 'Customer'}
          </CardTitle>
          <span className="shrink-0 rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
            {humanize(job.status)}
          </span>
        </div>
        <p className="font-mono text-[13px] tabular-nums text-muted-foreground">
          {job.referenceNumber}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Contact + navigate (anchors styled as buttons; Button has no asChild) */}
        <div className="flex flex-wrap gap-2">
          {job.customerPhone && (
            <a
              href={`tel:${job.customerPhone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium text-foreground active:bg-accent"
            >
              <Phone className="size-4" /> Call
            </a>
          )}
          {job.address && (
            <a
              href={directionsUrl(job.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium text-foreground active:bg-accent"
            >
              <Navigation className="size-4" /> Navigate
            </a>
          )}
        </div>

        {job.address && <p className="text-[15px]">{job.address}</p>}

        {/* What */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[13px] font-medium">
            {humanize(job.issueType)}
          </span>
          {job.systemType && (
            <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[13px]">
              {humanize(job.systemType)}
            </span>
          )}
          <span className="rounded-[3px] border border-warning-border bg-warning-light px-2 py-0.5 text-[11px] font-semibold tracking-[0.07em] text-warning-strong uppercase">
            {humanize(job.urgency)}
          </span>
        </div>

        {windowLabel && (
          <p className="flex items-center gap-1.5 text-[15px] text-muted-foreground">
            <Clock className="size-4 text-foreground-faint" /> {windowLabel}
          </p>
        )}

        {job.description && (
          <p className="whitespace-pre-wrap text-[15px]">{job.description}</p>
        )}

        {job.accessNotes && (
          <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px] text-foreground">
            <span className="font-medium">Access: </span>
            {job.accessNotes}
          </p>
        )}

        {/* Advance status */}
        {job.allowedNextStatuses.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {pendingConfirm ? (
              <div
                role="alertdialog"
                aria-label={buildStatusConfirmCopy(pendingConfirm).question}
                className="w-full space-y-2 rounded-md border border-danger-border bg-danger-light p-3"
              >
                <p className="text-[15px] font-medium text-danger-strong">
                  {buildStatusConfirmCopy(pendingConfirm).question}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    /* solid danger: the tinted default would vanish on the
                     * danger-light confirm panel it sits inside */
                    className="h-11 flex-1 rounded-xl bg-danger text-[15px] text-danger-foreground hover:bg-danger-strong"
                    disabled={advancing !== null}
                    onClick={() => {
                      const status = pendingConfirm;
                      setPendingConfirm(null);
                      void advance(status);
                    }}
                  >
                    {advancing === pendingConfirm
                      ? 'Saving…'
                      : buildStatusConfirmCopy(pendingConfirm).confirmLabel}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 flex-1 rounded-xl text-[15px]"
                    disabled={advancing !== null}
                    onClick={() => setPendingConfirm(null)}
                  >
                    {buildStatusConfirmCopy(pendingConfirm).cancelLabel}
                  </Button>
                </div>
              </div>
            ) : (
              job.allowedNextStatuses.map((s) => (
                <Button
                  key={s}
                  variant={isTerminalStatus(s) ? 'destructive' : 'default'}
                  className="h-11 rounded-xl px-4 text-[15px]"
                  disabled={advancing !== null}
                  onClick={() => handleStatusTap(s)}
                >
                  {advancing === s ? 'Saving…' : techStatusLabel(s)}
                </Button>
              ))
            )}
          </div>
        )}

        {error && <p className="text-[13px] text-danger-strong">{error}</p>}
      </CardContent>
    </Card>
  );
}
