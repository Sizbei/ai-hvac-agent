/**
 * Pure helpers for the "confirm before a terminal status change" gate
 * (Rtech-4). A technician tapping Cancelled/Completed must pass an explicit
 * second confirmation step before the status POST fires; Scheduled/
 * In progress/On hold keep advancing immediately, same as before.
 */

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
};

/** Button wording for a manual status target: field phrasing for the travel
 * taps, humanized sentence case for everything else. */
export function techStatusLabel(status: string): string {
  return (
    TECH_STATUS_LABELS[status] ??
    status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}
