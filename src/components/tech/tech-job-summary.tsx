'use client';

import { useCallback, useEffect, useState } from 'react';
import { Phone, Navigation, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { READ_ONLY_PREVIEW } from '@/lib/admin/preview-view';
import { useTechReadOnly } from '@/components/tech/tech-read-only-context';
import { Skeleton } from '@/components/ui/skeleton';
import { issueLabel, visitWindow } from '@/lib/tech/job-display';
import { customerNameLabel } from '@/lib/admin/request-labels';
import { readableDescription } from '@/lib/admin/long-text';
import { CloseOutSheet, type SheetConfirmOptions } from '@/components/tech/close-out-sheet';
import {
  actionButtonVariant,
  actionNeedsSheet,
  actionSpansRow,
  showRequestBehind,
  relevantBlockers,
  techStatusLabel,
  urgencyTone,
  type SheetAction,
} from '@/components/tech/tech-status-confirm';
import type { Blocker, TechAction } from '@/lib/tech/status-actions';
import { TechInvoiceCard } from '@/components/tech/invoice/tech-invoice-card';
import { jobLoadOutcome, type JobLoadOutcome } from '@/lib/tech/job-page-state';

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
  readonly assignment: { readonly appointmentId: string; readonly isLead: boolean } | null;
  readonly activeVisitId: string | null;
  readonly allowedActions: readonly TechAction[];
  readonly blockers: readonly Blocker[];
  readonly native: boolean;
  readonly invoiceSummary: { readonly id: string; readonly state: string; readonly balanceCents: number } | null;
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
/** What the job page needs from each summary load (null unless the load succeeded). */
export interface SummaryLoaded {
  readonly status: string;
  readonly invoiceState: string | null;
  /** M3d: the Forms card's visit pick and the close-out reminder. */
  readonly native: boolean;
  readonly assignmentVisitId: string | null;
  readonly activeVisitId: string | null;
}

export function TechJobSummary({
  id,
  appointmentId,
  unbilledParts = 0,
  formReminders = [],
  onStatusChanged,
  onLoaded,
}: {
  readonly id: string;
  readonly appointmentId?: string;
  /** Parts on no non-void invoice, for the Close out heads-up. */
  readonly unbilledParts?: number;
  /** M3d: required forms with no submitted copy (the close-out reminder links). */
  readonly formReminders?: ReadonlyArray<{ readonly name: string; readonly href: string }>;
  readonly onStatusChanged?: () => void;
  /** Called after each summary load; 'not_found' lets the page drop every form. */
  readonly onLoaded?: (outcome: JobLoadOutcome, job: SummaryLoaded | null) => void;
}) {
  const [job, setJob] = useState<TechJobSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState<string | null>(null);
  const readOnly = useTechReadOnly();
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
      const outcome = jobLoadOutcome(res.status, res.ok && body.success === true);
      if (outcome === 'ok') {
        setJob(body.data);
        setServerBlockers(null);
        setRequestBehind(false);
        setError(null);
      } else {
        setError("Couldn't load this job.");
      }
      onLoaded?.(
        outcome,
        outcome === 'ok'
          ? {
              status: String(body.data.status),
              invoiceState: body.data.invoiceSummary?.state ?? null,
              native: body.data.native === true,
              assignmentVisitId: body.data.assignment?.appointmentId ?? null,
              activeVisitId: body.data.activeVisitId ?? null,
            }
          : null,
      );
    } catch {
      setError("Couldn't load this job.");
      onLoaded?.('error', null);
    } finally {
      setIsLoading(false);
    }
  }, [id, appointmentId, onLoaded]);

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
          // The tap is saved: refresh the time card and history now, alongside the summary.
          onStatusChanged?.();
          await load();
          // After load(), which resets the flag: keep the response's flag until the next reload.
          setRequestBehind(data.requestBehind === true);
        } else {
          const message = body?.error?.message ?? "Couldn't update this request. Please try again.";
          // The job moved under us: refresh so the buttons match what the server allows now.
          if (body?.error?.code === 'STALE') await load();
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

  // The primary status button first and full width; the rest below it.
  const offered = ACTION_ORDER.filter((a) => job.allowedActions.includes(a));
  const actions = [
    ...offered.filter((a) => actionButtonVariant(a, offered) === 'default'),
    ...offered.filter((a) => actionButtonVariant(a, offered) !== 'default'),
  ];
  const windowLabel = visitWindow(job.arrivalWindowStart, job.arrivalWindowEnd, new Date());

  return (
    <>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-[17px]">
            {customerNameLabel(job.customerName)}
          </CardTitle>
          <span className="shrink-0 rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[13px] font-medium text-muted-foreground">
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
            {issueLabel(job.issueType)}
          </span>
          {job.systemType && (
            <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[13px]">
              {humanize(job.systemType)}
            </span>
          )}
          <span
            className={`rounded-[3px] border px-2 py-0.5 text-[13px] ${
              urgencyTone(job.urgency) === 'warning'
                ? 'border-warning-border bg-warning-light font-medium text-warning-strong'
                : 'border-border bg-surface-raised text-muted-foreground'
            }`}
          >
            {humanize(job.urgency)} urgency
          </span>
        </div>

        {windowLabel && (
          <p className="flex items-center gap-1.5 text-[15px] text-muted-foreground">
            <Clock className="size-4 text-foreground-faint" /> {windowLabel}
          </p>
        )}

        {job.description && (
          <p className="whitespace-pre-wrap break-words text-[15px]">{readableDescription(job.description)}</p>
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
                {/* "saved" only when the last response said so; on load it is just waiting. */}
                {requestBehind
                  ? 'Your status is saved; the request is waiting on an earlier visit.'
                  : 'Waiting on an earlier visit.'}
              </p>
            )}
            {actions.length > 0 && (
              <div className="grid grid-cols-2 gap-2 border-t pt-3">
                {actions.map((a, i) => (
                  // The span carries the grid cell (and the preview tooltip: a disabled button gets no hover).
                  <span
                    key={a}
                    title={readOnly ? READ_ONLY_PREVIEW : undefined}
                    className={`grid ${actionSpansRow(i, actions.length, actionButtonVariant(actions[0], actions) === 'default') ? 'col-span-2' : ''}`}
                  >
                    <Button
                      variant={actionButtonVariant(a, actions)}
                      className="h-12 rounded-xl px-4 text-[16px]"
                      disabled={advancing !== null || readOnly}
                      onClick={() => handleTap(a)}
                    >
                      {advancing === a ? 'Saving…' : techStatusLabel(a)}
                    </Button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <CloseOutSheet
          action={sheetAction}
          blockers={relevantBlockers(serverBlockers ?? job.blockers)}
          invoice={job.invoiceSummary}
          unbilledParts={unbilledParts}
          reminders={formReminders}
          native={job.native}
          pending={advancing !== null}
          error={sheetError}
          onConfirm={(a, options) => void advance(a, options)}
          onClose={() => { setSheetAction(null); setSheetError(null); setServerBlockers(null); }}
        />

        {error && <p className="text-[13px] text-danger-strong">{error}</p>}
      </CardContent>
    </Card>
    <TechInvoiceCard
      jobId={job.id}
      native={job.native}
      status={job.status}
      isLead={job.assignment?.isLead ?? false}
      invoiceSummary={job.invoiceSummary}
    />
    </>
  );
}
