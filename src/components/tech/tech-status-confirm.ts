/**
 * Pure copy helpers for the technician job screen: button labels, the bottom
 * sheet for Done / Pause / Hold / Close out, close-out blockers and the
 * assignment status badge.
 */

import type { Blocker } from '@/lib/tech/status-actions';

const TECH_STATUS_LABELS: Record<string, string> = {
  en_route: 'On my way',
  arrived: "I've arrived",
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
