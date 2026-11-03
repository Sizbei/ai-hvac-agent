/**
 * Pure helpers for the "confirm before a terminal status change" gate
 * (Rtech-4). A technician tapping Cancelled/Completed must pass an explicit
 * second confirmation step before the status POST fires; Scheduled/
 * In progress/On hold keep advancing immediately, same as before.
 */

import type { Blocker } from '@/lib/tech/status-actions';

const TERMINAL_STATUSES = new Set(['cancelled', 'completed']);

/** True for the two destructive/terminal manual targets — no further manual
 * transition exists once reached (see `TRANSITIONS` /
 * `MANUAL_TARGET_STATUSES` in `src/lib/admin/request-status.ts`). */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface StatusConfirmCopy {
  readonly question: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

function humanizeLower(status: string): string {
  return status.replace(/_/g, ' ');
}

/** Confirm-step copy for a terminal status target. Sentence case, "request"
 * (not "job"), and states plainly that the change can't be undone. */
export function buildStatusConfirmCopy(status: string): StatusConfirmCopy {
  const label = humanizeLower(status);
  return {
    question: `Mark this request ${label}? This can't be undone.`,
    confirmLabel: `Yes, mark ${label}`,
    cancelLabel: 'No, go back',
  };
}

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
    title: 'Put this job on hold?',
    description: 'Holding ends this visit. The office will plan the next one.',
    confirmLabel: 'Hold job',
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
      return `${b.technicianName} is still working`;
    case 'visit_planned':
      return b.date
        ? `Visit #${b.appointmentNumber} on ${shortDate(b.date)} is planned — put this job on hold`
        : `Visit #${b.appointmentNumber} is planned — put this job on hold`;
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
