/**
 * Single source of truth: status/urgency enum values -> semantic token classes.
 *
 * All entries use only design tokens (--success-light, --warning-light, etc.)
 * so dark-mode comes for free. Raw Tailwind palette classes are not permitted.
 *
 * The badge classes use the chip contract: `bg-<sem>-light text-<sem>-strong
 * border-<sem>-border`. The dot classes use a single background token (for
 * small inline indicators).
 *
 * Family semantics:
 *  - marker (teal) = in motion / being worked right now
 *  - info (blue)   = informational, no action implied
 *  - success / warning / danger = outcome states
 *  - muted         = inert / terminal-neutral
 *
 * Every text-on-background pairing here is asserted >=4.5:1 by
 * `status-colors-contrast.test.ts`, which reads the token values out of
 * globals.css.
 */

// Request / job status

/** Tailwind token classes for the `request_status` enum values. */
export const REQUEST_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-warning-light text-warning-strong border-warning-border',
  assigned: 'bg-marker-light text-marker-strong border-marker-border',
  scheduled: 'bg-marker-light text-marker-strong border-marker-border',
  in_progress: 'bg-marker-light text-marker-strong border-marker-border',
  on_hold: 'bg-warning-light text-warning-strong border-warning-border',
  completed: 'bg-success-light text-success-strong border-success-border',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

/** Fallback for any unknown request status. */
export const REQUEST_STATUS_DEFAULT = REQUEST_STATUS_BADGE.pending;

/** Token-based dot background class for the `request_status` enum.
 *  Used by BookingHistoryList and similar inline indicators. */
export const REQUEST_STATUS_DOT: Record<string, string> = {
  pending: 'bg-warning',
  assigned: 'bg-marker',
  scheduled: 'bg-marker',
  in_progress: 'bg-marker',
  on_hold: 'bg-warning',
  completed: 'bg-success',
  cancelled: 'bg-muted-foreground',
};

export const REQUEST_STATUS_DOT_DEFAULT = REQUEST_STATUS_DOT.cancelled;

// Conversation / session status

/** Tailwind token classes for conversation/session status values. */
export const SESSION_STATUS_BADGE: Record<string, string> = {
  chatting: 'bg-info-light text-info-strong border-info-border',
  extracting: 'bg-info-light text-info-strong border-info-border',
  confirmed: 'bg-success-light text-success-strong border-success-border',
  submitted: 'bg-success-light text-success-strong border-success-border',
  escalated: 'bg-warning-light text-warning-strong border-warning-border',
  abandoned: 'bg-muted text-muted-foreground border-border',
  // outcome values (session_outcome enum)
  booked: 'bg-success-light text-success-strong border-success-border',
  info_provided: 'bg-info-light text-info-strong border-info-border',
  unresolved: 'bg-danger-light text-danger-strong border-danger-border',
};

export const SESSION_STATUS_DEFAULT = SESSION_STATUS_BADGE.chatting;

// Invoice / estimate money states

/** Token classes for invoice `state` enum values (draft/open/paid/void/refunded). */
export const INVOICE_STATE_BADGE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  open: 'bg-info-light text-info-strong border-info-border',
  paid: 'bg-success-light text-success-strong border-success-border',
  void: 'bg-muted text-muted-foreground border-border',
  refunded: 'bg-warning-light text-warning-strong border-warning-border',
};

export const INVOICE_STATE_DEFAULT = INVOICE_STATE_BADGE.draft;

/** Token classes for native estimate `status` enum values. */
export const ESTIMATE_STATUS_BADGE: Record<string, string> = {
  open: 'bg-info-light text-info-strong border-info-border',
  sold: 'bg-success-light text-success-strong border-success-border',
  dismissed: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-warning-light text-warning-strong border-warning-border',
};

export const ESTIMATE_STATUS_DEFAULT = ESTIMATE_STATUS_BADGE.dismissed;

/** Token classes for FieldPulse estimate status names (Sent/Estimate/Accepted/…). */
export const FPS_STATUS_BADGE: Record<string, string> = {
  Sent: 'bg-info-light text-info-strong border-info-border',
  Estimate: 'bg-muted text-muted-foreground border-border',
  Accepted: 'bg-success-light text-success-strong border-success-border',
  Completed: 'bg-success-light text-success-strong border-success-border',
  Lost: 'bg-danger-light text-danger-strong border-danger-border',
  Draft: 'bg-warning-light text-warning-strong border-warning-border',
};

export const FPS_STATUS_DEFAULT = 'bg-muted text-muted-foreground border-border';

// Urgency

/** Tailwind token classes for the `urgency` enum values. */
export const URGENCY_BADGE: Record<string, string> = {
  emergency: 'bg-danger-light text-danger-strong border-danger-border',
  high: 'bg-warning-light text-warning-strong border-warning-border',
  medium: 'bg-info-light text-info-strong border-info-border',
  low: 'bg-muted text-muted-foreground border-border',
};

export const URGENCY_DEFAULT = URGENCY_BADGE.low;

// Last-seen freshness dot (customer-people-cards)

/** Returns the token-based dot background class for a last-service-date string. */
export function lastSeenDotClass(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'bg-muted-foreground';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'bg-muted-foreground';
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days < 0 || days <= 30) return 'bg-success';
  if (days <= 90) return 'bg-warning';
  return 'bg-muted-foreground';
}
