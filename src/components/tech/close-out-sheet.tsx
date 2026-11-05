'use client';

import { useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { HOLD_REASONS, type HoldReason } from '@/lib/admin/request-status';
import type { Blocker } from '@/lib/tech/status-actions';
import {
  buildActionSheetCopy,
  closeOutInvoiceWarning,
  describeBlocker,
  holdReasonLabel,
  relevantBlockers,
  type CloseOutInvoice,
  type SheetAction,
} from '@/components/tech/tech-status-confirm';

export interface SheetConfirmOptions {
  readonly holdReason?: HoldReason;
  /** ISO datetime */
  readonly followUpDate?: string;
}

const FIELD =
  'h-11 w-full rounded-xl border border-border-input bg-surface-raised px-3 text-[15px] text-foreground';

function blockerKey(b: Blocker): string {
  if (b.kind === 'technician_open') return `${b.kind}-${b.technicianId}-${b.appointmentNumber}`;
  if (b.kind === 'earlier_visit_open' || b.kind === 'visit_planned') return `${b.kind}-${b.appointmentNumber}`;
  return b.kind;
}

/**
 * Bottom sheet for the actions that end or pause work: Done, Pause, Hold and
 * Close out. Close out shows what is still in the way (instead of the confirm
 * button) when `blockers` is non-empty.
 */
export function CloseOutSheet({
  action,
  blockers,
  invoice = null,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  readonly action: SheetAction | null;
  readonly blockers: readonly Blocker[];
  /** The job's invoice, for the Close out heads-up (draft / balance due). */
  readonly invoice?: CloseOutInvoice | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: (action: SheetAction, options: SheetConfirmOptions) => void;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState<HoldReason>(HOLD_REASONS[0]);
  const [followUp, setFollowUp] = useState('');
  // A fresh open starts from defaults, so a second hold is not pre-filled.
  const [wasOpen, setWasOpen] = useState(false);
  if ((action !== null) !== wasOpen) {
    setWasOpen(action !== null);
    if (action !== null) {
      setReason(HOLD_REASONS[0]);
      setFollowUp('');
    }
  }
  const today = new Date().toLocaleDateString('en-CA');

  // Keep the last action's copy mounted while the sheet animates out.
  const [shown, setShown] = useState<SheetAction>('completed');
  if (action && action !== shown) setShown(action);
  const copy = buildActionSheetCopy(shown);
  const blocked = shown === 'close_out' ? relevantBlockers(blockers) : [];
  const invoiceWarning = shown === 'close_out' && blocked.length === 0 ? closeOutInvoiceWarning(invoice) : null;

  function confirm(): void {
    if (!action) return;
    if (action === 'on_hold') {
      onConfirm(action, {
        holdReason: reason,
        followUpDate: followUp ? new Date(`${followUp}T12:00:00`).toISOString() : undefined,
      });
    } else {
      onConfirm(action, {});
    }
  }

  return (
    <Sheet open={action !== null} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[17px]">{blocked.length > 0 ? "Can't close out yet" : copy.title}</SheetTitle>
          <SheetDescription className="text-[15px]">
            {blocked.length > 0 ? 'Finish these first, then try again.' : copy.description}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4">
          {blocked.length > 0 && (
            <ul className="space-y-2" aria-label="What is still open">
              {blocked.map((b) => (
                <li
                  key={blockerKey(b)}
                  className="rounded-md border border-warning-border bg-warning-light px-3 py-2.5 text-[15px] text-foreground"
                >
                  {describeBlocker(b)}
                </li>
              ))}
            </ul>
          )}

          {invoiceWarning && (
            <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2.5 text-[15px] text-foreground">
              {invoiceWarning}
            </p>
          )}

          {shown === 'on_hold' && (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-muted-foreground">Reason</span>
                <select className={FIELD} value={reason} onChange={(e) => setReason(e.target.value as HoldReason)}>
                  {HOLD_REASONS.map((r) => (
                    <option key={r} value={r}>{holdReasonLabel(r)}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-muted-foreground">Follow up on (optional)</span>
                <input type="date" min={today} className={FIELD} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
              </label>
            </div>
          )}

          {error && <p role="alert" className="text-[13px] text-danger-strong">{error}</p>}

          <div className="flex flex-col gap-2 pt-1">
            {blocked.length === 0 && (
              <Button
                variant={shown === 'close_out' ? 'destructive' : 'default'}
                className="h-12 w-full rounded-xl text-[16px]"
                disabled={pending}
                onClick={confirm}
              >
                {pending ? 'Saving…' : copy.confirmLabel}
              </Button>
            )}
            <Button variant="outline" className="h-12 w-full rounded-xl text-[16px]" disabled={pending} onClick={onClose}>
              {blocked.length > 0 ? 'Got it' : 'Cancel'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
