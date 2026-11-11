/**
 * A collections predicate: an invoice belongs in the collections workspace and
 * may be dunned ONLY when it is OPEN (sent, awaiting payment) and still carries a
 * balance. `paid`/`void`/`refunded`/`draft` are excluded — notably a FULL REFUND
 * lands in `refunded` with totalCents still set, so `state !== 'paid'` (the old
 * check) wrongly treated it as owed. `draft` is pre-send, so it is not dunnable.
 */
export function isCollectible(inv: {
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
}): boolean {
  return inv.state === 'open' && inv.totalCents - inv.amountPaidCents > 0;
}

/** Don't re-send a manual reminder within this window (client + server share it). */
export const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Returns true when enough time has passed since the last reminder to allow
 * re-sending. Pass `Date.now()` for `nowMs` in production; inject a fixed
 * value in tests.
 */
export function canResend(
  lastReminderSentAt: string | null,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (!lastReminderSentAt) return true;
  return nowMs - new Date(lastReminderSentAt).getTime() >= cooldownMs;
}

/**
 * Human-readable invoice reference. A mirrored invoice shows the number its
 * source system (FieldPulse / Housecall Pro) uses, so the office can match it
 * to their own records; a native invoice has no number, so it's cut from the UUID.
 */
export function invoiceRef(invoiceId: string, externalRef?: string | null): string {
  if (externalRef) return `#${externalRef}`;
  return `#${invoiceId.slice(0, 8).toUpperCase()}`;
}
