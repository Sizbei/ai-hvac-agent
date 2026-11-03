'use client';

import { useCallback, useEffect, useState } from 'react';
import { Phone, Navigation, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatArrivalWindow } from '@/lib/admin/arrival-window';
import { CloseOutSheet, type SheetConfirmOptions } from '@/components/tech/close-out-sheet';
import {
  actionNeedsSheet,
  showRequestBehind,
  relevantBlockers,
  techStatusLabel,
  type SheetAction,
} from '@/components/tech/tech-status-confirm';
import type { Blocker, TechAction } from '@/lib/tech/status-actions';

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
  readonly assignment: { readonly appointmentId: string } | null;
  readonly allowedActions: readonly TechAction[];
  readonly blockers: readonly Blocker[];
  readonly native: boolean;
}

interface ActionResult {
  readonly requestBehind?: boolean;
}

const ACTION_ORDER: readonly TechAction[] = ['en_route', 'arrived', 'in_progress', 'completed', 'pause', 'on_hold', 'close_out'];

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
  const [sheetAction, setSheetAction] = useState<SheetAction | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // Set after a lead's tap when the request itself is still waiting on an earlier visit.
  const [requestBehind, setRequestBehind] = useState(false);
  // Blockers the server reported on a refused close-out (fresher than the load).
  const [serverBlockers, setServerBlockers] = useState<readonly Blocker[] | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const query = appointmentId ? `?appointmentId=${encodeURIComponent(appointmentId)}` : '';
      const res = await fetch(`/api/tech/jobs/${id}${query}`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setJob(body.data);
        setServerBlockers(null);
        setRequestBehind(false);
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
    async (action: TechAction, options: SheetConfirmOptions = {}): Promise<void> => {
      if (!job?.assignment) return;
      const viaSheet = actionNeedsSheet(action);
      setAdvancing(action);
      setError(null);
      setSheetError(null);
      try {
        const res = await fetch(`/api/tech/jobs/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appointmentId: job.assignment.appointmentId, action, ...options }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          const data: ActionResult = body?.data ?? {};
          setServerBlockers(null);
          setSheetAction(null);
          await load();
          // After load(), which resets the flag: keep the response's flag until the next reload.
          setRequestBehind(data.requestBehind === true);
          onStatusChanged?.();
        } else {
          const message = body?.error?.message ?? "Couldn't update this request. Please try again.";
          const refused = body?.error?.details?.blockers;
          const blockedNow =
            body?.error?.code === 'CLOSE_OUT_BLOCKED' && Array.isArray(refused)
              ? relevantBlockers(refused as Blocker[])
              : [];
          if (blockedNow.length > 0) setServerBlockers(blockedNow);
          else if (viaSheet) setSheetError(message);
          else setError(message);
        }
      } catch {
        const message = "Couldn't reach the server. Please try again.";
        if (viaSheet) setSheetError(message);
        else setError(message);
      } finally {
        setAdvancing(null);
      }
    },
    [id, job, load, onStatusChanged],
  );

  const handleTap = useCallback(
    (action: TechAction): void => {
      if (actionNeedsSheet(action)) {
        setSheetError(null);
        setSheetAction(action);
      } else {
        void advance(action);
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

  const actions = ACTION_ORDER.filter((a) => job.allowedActions.includes(a));
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

        {/* Actions */}
        {!job.native ? (
          <p className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-[15px] text-muted-foreground">
            Managed in FieldPulse. Update this job there.
          </p>
        ) : (
          <>
            {showRequestBehind(job.blockers, requestBehind) && (
              <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2.5 text-[15px]">
                Your status is saved; the request is waiting on an earlier visit.
              </p>
            )}
            {actions.length > 0 && (
              <div className="grid grid-cols-2 gap-2 border-t pt-3">
                {actions.map((a, i) => (
                  <Button
                    key={a}
                    variant={a === 'close_out' ? 'destructive' : actionNeedsSheet(a) ? 'outline' : 'default'}
                    className={`h-12 rounded-xl px-4 text-[16px] ${actions.length % 2 === 1 && i === 0 ? 'col-span-2' : ''}`}
                    disabled={advancing !== null}
                    onClick={() => handleTap(a)}
                  >
                    {advancing === a ? 'Saving…' : techStatusLabel(a)}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}

        <CloseOutSheet
          action={sheetAction}
          blockers={relevantBlockers(serverBlockers ?? job.blockers)}
          pending={advancing !== null}
          error={sheetError}
          onConfirm={(a, options) => void advance(a, options)}
          onClose={() => { setSheetAction(null); setSheetError(null); setServerBlockers(null); }}
        />

        {error && <p className="text-[13px] text-danger-strong">{error}</p>}
      </CardContent>
    </Card>
  );
}
