/**
 * Pure copy helpers for the technician job screen: button labels, the bottom
 * sheet for Done / Pause / Hold / Close out, close-out blockers and the
 * assignment status badge.
 */

import type { Blocker } from '@/lib/tech/status-actions';
import { formatCentsExact } from '@/lib/admin/money-format';

const TECH_STATUS_LABELS: Record<string, string> = {
  en_route: 'On my way',
  arrived: "I've arrived",
  in_progress: 'Working',
  completed: 'Done',
  pause: 'Pause',
  on_hold: 'Hold',
  close_out: 'Close out',
};

/** Button wording for a manual status target: field phrasing for the travel
 * taps, humanized sentence case for everything else. */
export function techStatusLabel(status: string): string {
  return (
    TECH_STATUS_LABELS[status] ??
    status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

const SHEET_ACTIONS = new Set(['completed', 'pause', 'on_hold', 'close_out']);

/** Done / Pause / Hold / Close out open the sheet; the travel and Working taps post directly. */
export type SheetAction = 'completed' | 'pause' | 'on_hold' | 'close_out';

export function actionNeedsSheet(action: string): action is SheetAction {
  return SHEET_ACTIONS.has(action);
}

export interface ActionSheetCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

const SHEET_COPY: Record<SheetAction, ActionSheetCopy> = {
  completed: {
    title: 'Done with your part?',
    description: 'This stops your timer. The request stays open until it is closed out.',
    confirmLabel: 'Done',
  },
  pause: {
    title: 'Pause this visit?',
    description: 'Your timer stops. Tap Working when you are back at it.',
    confirmLabel: 'Pause',
  },
  on_hold: {
    title: 'Put this request on hold?',
    description: 'Holding ends this visit. The office will plan the next one.',
    confirmLabel: 'Hold request',
  },
  close_out: {
    title: 'Close out this request?',
    description: "This marks the whole request completed. It can't be undone.",
    confirmLabel: 'Close out',
  },
};

export function buildActionSheetCopy(action: SheetAction): ActionSheetCopy {
  return SHEET_COPY[action];
}

/** Assignment status badge: "in_progress" -> "In progress", "en_route" -> "En route". */
export function labelAssignmentStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "awaiting_parts" -> "Awaiting parts". */
export function holdReasonLabel(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** The blockers that stop a close-out; not_lead / managed_externally are shown as notices instead. */
export function relevantBlockers(blockers: readonly Blocker[]): readonly Blocker[] {
  return blockers.filter((b) => b.kind !== 'not_lead' && b.kind !== 'managed_externally');
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

/** One plain-words line per blocker, written for the technician. */
export function describeBlocker(b: Blocker): string {
  switch (b.kind) {
    case 'technician_open':
      return b.started ? `${b.technicianName} is still working` : `${b.technicianName} hasn't started yet`;
    case 'visit_planned':
      return b.date
        ? `Visit #${b.appointmentNumber} on ${shortDate(b.date)} is planned — put this request on hold`
        : `Visit #${b.appointmentNumber} is planned — put this request on hold`;
    case 'earlier_visit_open':
      return `Waiting on an earlier visit (${b.technicianName}, visit #${b.appointmentNumber})`;
    case 'request_not_started':
      return 'Tap Working first';
    case 'not_lead':
      return 'Only the lead technician can close out this request';
    case 'managed_externally':
      return 'Managed in FieldPulse';
  }
}

/** The request is waiting on an earlier visit: derived from loaded blockers, or the last response said so. */
export function showRequestBehind(blockers: readonly Blocker[], lastResponseBehind: boolean): boolean {
  return lastResponseBehind || blockers.some((b) => b.kind === 'earlier_visit_open');
}

/** The summary's invoice fields the close-out warning reads. */
export interface CloseOutInvoice {
  readonly state: string;
  readonly balanceCents: number;
}

/**
 * A heads-up line in the Close out sheet (the lead can still close out): a
 * draft invoice is not approved yet; an open one with a balance is still due.
 */
export function closeOutInvoiceWarning(invoice: CloseOutInvoice | null): string | null {
  if (!invoice) return null;
  if (invoice.state === 'draft') return "The invoice isn't approved yet.";
  if (invoice.state === 'open' && invoice.balanceCents > 0) {
    return `The invoice still has ${formatCentsExact(invoice.balanceCents)} due.`;
  }
  return null;
}

/**
 * Close out heads-up for parts on no non-void invoice (shown even when the
 * job has no invoice at all; the lead can still close out).
 */
export function unbilledPartsWarning(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 part isn't on an invoice yet." : `${count} parts aren't on an invoice yet.`;
}

/**
 * Shown on the material form BEFORE saving when the request's invoice has
 * left draft: a new part can't join it, so the office bills it separately.
 * A draft (or no invoice) takes the part via the invoice page: no warning.
 */
export function lateMaterialWarning(invoiceState: string | null | undefined): string | null {
  if (invoiceState === 'open') return "This part won't be on the open invoice. The office can bill it separately.";
  if (invoiceState === 'paid' || invoiceState === 'refunded') {
    return `This part won't be on the ${invoiceState} invoice. The office can bill it separately.`;
  }
  return null;
}

/** The travel and Working taps, in the order a visit moves through them. */
const FORWARD_TAPS: readonly string[] = ['en_route', 'arrived', 'in_progress'];

/**
 * One primary button per state: the next forward tap (On my way, I've
 * arrived, Working) when one is offered, else the finish (Close out or Done).
 * Everything else is outline; Close out is never destructive red.
 */
export function actionButtonVariant(action: string, actions: readonly string[]): 'default' | 'outline' {
  const primary =
    actions.find((a) => FORWARD_TAPS.includes(a)) ??
    actions.find((a) => a === 'close_out') ??
    actions.find((a) => a === 'completed');
  return action === primary ? 'default' : 'outline';
}

/**
 * Status button grid (two columns): the primary button (first) spans the row;
 * the rest pair up, and a lone last one spans its row too.
 */
export function actionSpansRow(index: number, count: number, firstIsPrimary: boolean): boolean {
  if (firstIsPrimary && index === 0) return true;
  const start = firstIsPrimary ? 1 : 0;
  const rest = count - start;
  return rest % 2 === 1 && index === count - 1;
}

/** Urgency chip: amber only for high and emergency; low and medium stay neutral. */
export function urgencyTone(urgency: string): 'warning' | 'neutral' {
  return urgency === 'high' || urgency === 'emergency' ? 'warning' : 'neutral';
}

/** A completed or cancelled request: the job page shows saved work read-only. */
export function jobIsClosed(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled';
}
