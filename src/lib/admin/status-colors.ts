/**
 * Single source of truth: status/urgency enum values -> semantic token classes.
 *
 * All entries use only design tokens (--success-light, --warning-light, etc.)
 * so dark-mode comes for free. Raw Tailwind palette classes are not permitted.
 *
 * The badge classes use bg-*-light text-* border-* (outline badge style).
 * The dot classes use a single background token (for small inline indicators).
 */

// Request / job status

/** Tailwind token classes for the `request_status` enum values. */
export const REQUEST_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-warning-light text-warning-foreground border-warning/30',
  assigned: 'bg-info-light text-info-foreground border-info/30',
  scheduled: 'bg-primary/10 text-primary border-primary/20',
  in_progress: 'bg-info-light text-info-foreground border-info/30',
  on_hold: 'bg-warning-light text-warning-foreground border-warning/30',
  completed: 'bg-success-light text-success-strong border-success/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

/** Fallback for any unknown request status. */
export const REQUEST_STATUS_DEFAULT = REQUEST_STATUS_BADGE.pending;

/** Token-based dot background class for the `request_status` enum.
 *  Used by BookingHistoryList and similar inline indicators. */
export const REQUEST_STATUS_DOT: Record<string, string> = {
  pending: 'bg-warning',
  assigned: 'bg-info',
  scheduled: 'bg-primary',
  in_progress: 'bg-info',
  on_hold: 'bg-warning',
  completed: 'bg-success',
  cancelled: 'bg-muted-foreground',
};

export const REQUEST_STATUS_DOT_DEFAULT = REQUEST_STATUS_DOT.cancelled;

// Conversation / session status

/** Tailwind token classes for conversation/session status values. */
export const SESSION_STATUS_BADGE: Record<string, string> = {
  chatting: 'bg-info-light text-info-foreground border-info/30',
  extracting: 'bg-info-light text-info-foreground border-info/30',
  confirmed: 'bg-success-light text-success-strong border-success/30',
  submitted: 'bg-success-light text-success-strong border-success/30',
  escalated: 'bg-warning-light text-warning-foreground border-warning/30',
  abandoned: 'bg-muted text-muted-foreground border-border',
  // outcome values (session_outcome enum)
  booked: 'bg-success-light text-success-strong border-success/30',
  info_provided: 'bg-info-light text-info-foreground border-info/30',
  unresolved: 'bg-danger-light text-danger-strong border-danger/30',
};

export const SESSION_STATUS_DEFAULT = SESSION_STATUS_BADGE.chatting;

// Invoice / estimate money states

/** Token classes for invoice `state` enum values (draft/open/paid/void/refunded). */
export const INVOICE_STATE_BADGE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  open: 'bg-info-light text-info-foreground border-info/30',
  paid: 'bg-success-light text-success-strong border-success/30',
  void: 'bg-muted text-muted-foreground border-border',
  refunded: 'bg-warning-light text-warning-foreground border-warning/30',
};

export const INVOICE_STATE_DEFAULT = INVOICE_STATE_BADGE.draft;

/** Token classes for native estimate `status` enum values. */
export const ESTIMATE_STATUS_BADGE: Record<string, string> = {
  open: 'bg-info-light text-info-foreground border-info/30',
  sold: 'bg-success-light text-success-strong border-success/30',
  dismissed: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-warning-light text-warning-foreground border-warning/30',
};

export const ESTIMATE_STATUS_DEFAULT = ESTIMATE_STATUS_BADGE.dismissed;

/** Token classes for FieldPulse estimate status names (Sent/Estimate/Accepted/…). */
export const FPS_STATUS_BADGE: Record<string, string> = {
  Sent: 'bg-info-light text-info-foreground border-info/30',
  Estimate: 'bg-muted text-muted-foreground border-border',
  Accepted: 'bg-success-light text-success-strong border-success/30',
  Completed: 'bg-success-light text-success-strong border-success/30',
  Lost: 'bg-danger-light text-danger-strong border-danger/30',
  Draft: 'bg-warning-light text-warning-foreground border-warning/30',
};

export const FPS_STATUS_DEFAULT = 'bg-muted text-muted-foreground border-border';

// Urgency

/** Tailwind token classes for the `urgency` enum values. */
export const URGENCY_BADGE: Record<string, string> = {
  emergency: 'bg-danger-light text-danger-strong border-danger/30',
  high: 'bg-warning-light text-warning-foreground border-warning/30',
  medium: 'bg-info-light text-info-foreground border-info/30',
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
