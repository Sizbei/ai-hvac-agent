import type { ConversationChannel } from '@/lib/admin/conversation-types';

/**
 * Pure helpers for the human-takeover reply control (Rconv-1) and the
 * outcome/mode display (Rconv-2) in `ConversationDetailContent`. Kept free of
 * React/DOM so they're testable with plain vitest (repo has no jsdom/RTL).
 *
 * The server (`/api/admin/conversations/[id]/message/route.ts`) is the
 * authority on every rule here — these functions only mirror it for UX
 * (disabling a guaranteed-400 send, showing a length hint) or translate its
 * responses into human copy. Never a substitute for the server-side checks.
 */

/** Mirrors the server's zod bound (`message/route.ts:24`, `z.string().min(1).max(1600)`). */
export const REPLY_MAX_LENGTH = 1600;

/**
 * SMS is the only outbound channel the reply route supports
 * (`message/route.ts:83-89` rejects any other channel with `UNSUPPORTED_CHANNEL`).
 * A closed/retired SMS thread (token reshaped to `sms:<phone>:<sessionId>`) is
 * NOT detectable client-side — `ConversationDetail` never exposes the session
 * token — so that case still round-trips to the server and is handled via
 * `replyErrorToCopy`, not pre-disabled here.
 */
export function canReplyByChannel(channel: ConversationChannel): boolean {
  return channel === 'sms';
}

/**
 * Client-side mirror of the server's 1-1600 char bound, so the send button can
 * be disabled instead of guaranteed to 400. Returns a human sentence describing
 * the problem, or null when the message is sendable.
 */
export function getReplyLengthError(message: string): string | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return 'Enter a reply before sending.';
  }
  if (trimmed.length > REPLY_MAX_LENGTH) {
    return `Reply is too long — keep it under ${REPLY_MAX_LENGTH.toLocaleString()} characters.`;
  }
  return null;
}

// The consent route (`checkSendAllowed`, `src/lib/communication/consent.ts`)
// returns a machine-readable `reason` that the message route embeds verbatim
// into its error message (`Cannot message this customer: ${decision.reason}`,
// `message/route.ts:101-105`). Reachable reasons for this route's
// `triggerType: "escalation"` (toggle: null, quietHours: false) are
// `do_not_contact`, `channel_disabled:sms`, and `review_requests_off`; the
// prefix-matched fallbacks below keep this correct if that rule ever changes.
const CONSENT_MESSAGE_PREFIX = 'Cannot message this customer: ';

const CONSENT_REASON_COPY: Record<string, string> = {
  do_not_contact: 'This customer has asked not to be contacted.',
  'channel_disabled:sms': 'This customer has turned off text message notifications.',
  review_requests_off: 'Review texts are off for this account.',
};

/** Extracts the raw consent reason embedded in a CONSENT_BLOCKED message, or
 * null when the message doesn't match the server's known format. */
export function extractConsentReason(serverMessage: string): string | null {
  if (!serverMessage.startsWith(CONSENT_MESSAGE_PREFIX)) {
    return null;
  }
  const reason = serverMessage.slice(CONSENT_MESSAGE_PREFIX.length).trim();
  return reason.length > 0 ? reason : null;
}

function consentReasonToCopy(reason: string | null): string {
  if (!reason) {
    return "This customer can't be messaged right now.";
  }
  if (reason in CONSENT_REASON_COPY) {
    return CONSENT_REASON_COPY[reason];
  }
  if (reason.startsWith('channel_disabled:')) {
    return 'This customer has turned off notifications on this channel.';
  }
  if (reason.startsWith('type_disabled:')) {
    return 'This customer has turned off this type of notification.';
  }
  if (reason === 'quiet_hours') {
    return "It's currently quiet hours for this customer — try again later.";
  }
  return "This customer can't be messaged right now.";
}

export interface ReplyApiError {
  readonly code: string;
  readonly message: string;
}

/**
 * Maps every failure code the reply route can return to a sentence-case,
 * human sentence — never the raw code and never a bare `err.message`.
 * CONSENT_BLOCKED additionally decodes the reason `checkSendAllowed` embedded
 * in the server message instead of showing it raw.
 */
export function replyErrorToCopy(error: ReplyApiError): string {
  switch (error.code) {
    case 'DEMO_RESTRICTED':
      return 'Sending replies is turned off for this account.';
    case 'RATE_LIMITED':
      return "You're sending replies too quickly — wait a moment and try again.";
    case 'UNSUPPORTED_CHANNEL':
      return 'Replying is only available for active text-message conversations.';
    case 'CONSENT_BLOCKED':
      return consentReasonToCopy(extractConsentReason(error.message));
    case 'INVALID_INPUT':
      return `Enter a reply between 1 and ${REPLY_MAX_LENGTH.toLocaleString()} characters.`;
    case 'NOT_FOUND':
      return 'This conversation could not be found — it may have been deleted.';
    case 'UNAUTHORIZED':
      return 'Your session has expired — sign in again to reply.';
    default:
      return 'Could not send the reply — try again in a moment.';
  }
}

export interface ModeIndicator {
  readonly label: string;
  readonly variant: 'info' | 'warning';
}

/**
 * Derives the small mode indicator shown near the status badge. "human"
 * (a CSR has taken over, bot stays quiet) is styled like the existing
 * "escalated" warning tone; "ai" (bot auto-replies) matches the existing
 * "chatting"/"extracting" info tone — same token language as
 * `SESSION_STATUS_BADGE` (`src/lib/admin/status-colors.ts`), applied here via
 * the generic `ContextBadge` since mode isn't a status-colors entry.
 */
export function modeIndicator(mode: string): ModeIndicator {
  return mode === 'human' ? { label: 'Office replying', variant: 'warning' } : { label: 'AI replying', variant: 'info' };
}
