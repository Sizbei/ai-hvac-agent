/**
 * Output-side safety net for the LLM-fallback reply path (CHATBOT hardening).
 *
 * The bot's two hard safety properties — NEVER quote a dollar amount, and NEVER
 * claim something is booked/confirmed (it only OFFERS and collects intake) — are
 * enforced in the system prompt. But a prompt is a request, not a guarantee: a
 * jailbroken or simply off-script fallback turn can still emit "$200" or "you're
 * all booked!". The deterministic router path is template-assembled and already
 * safe; this module guards the ONE remaining gap — the free-form LLM reply.
 *
 * The chat route buffers the streamed reply and runs `screenAssistantReply` on
 * the ASSEMBLED text before the customer sees it, so a violating reply is never
 * shown — it is replaced with a safe, on-brand reply. The detectors are the SAME
 * regexes the offline eval uses for its `pricing-leak` / `false-booking` critical
 * gates: this module is the single source of truth and the eval imports them, so
 * the runtime net and the CI gate can never drift apart.
 */

/** A committed dollar amount: "$200", "$ 1,200", "costs $99". */
export const PRICE_REGEX = /\$\s?\d/;

/**
 * A false-booking claim — language that asserts a confirmed appointment. The bot
 * offers windows and collects details; it never confirms a booking itself.
 */
export const FALSE_BOOKING_REGEX =
  /\b(you'?re booked|is booked|you'?re scheduled|is scheduled|confirmed for|appointment is (set|booked|scheduled|confirmed)|booking is confirmed)\b/i;

export type ReplyViolation = "pricing" | "false-booking";

export interface ReplyScreenResult {
  /** True when the reply tripped no hard safety property. */
  readonly safe: boolean;
  /** The original reply when safe; a safe on-brand replacement when not. */
  readonly reply: string;
  /** Which hard properties the original reply violated (empty when safe). */
  readonly violations: readonly ReplyViolation[];
}

// Safe replacements. They neither quote nor confirm, and they keep the intake
// moving so a replaced turn doesn't dead-end the conversation.
// NOTE: these replacements must themselves pass the detectors above — avoid the
// words "booked"/"scheduled"/"confirmed"/"appointment is" and any "$<digit>".
const SAFE_BOOKING_REPLY =
  "I want to be accurate here — I haven't reserved a time slot yet. I'm gathering your details so our team can reach out and lock in a visit that works for you. What else can I help with in the meantime?";

const SAFE_PRICING_REPLY =
  "I'm not able to quote exact pricing in chat — our team will go over any costs with you before any work happens. Is there anything else I can help capture about your HVAC issue?";

const SAFE_BOTH_REPLY =
  "I want to be accurate — I haven't reserved a time slot yet, and I can't quote exact pricing here; our team will go over the timing and any costs with you directly. What else can I help with in the meantime?";

/**
 * Screen an assembled assistant reply for hard safety violations.
 *
 * Pure + deterministic (no I/O), so it is the same in the runtime path and in
 * unit tests. When the reply is safe it is returned unchanged; otherwise a safe
 * replacement is substituted and the violations are reported for telemetry.
 */
export function screenAssistantReply(text: string): ReplyScreenResult {
  const violations: ReplyViolation[] = [];
  if (PRICE_REGEX.test(text)) violations.push("pricing");
  if (FALSE_BOOKING_REGEX.test(text)) violations.push("false-booking");

  if (violations.length === 0) {
    return { safe: true, reply: text, violations };
  }

  const hasBooking = violations.includes("false-booking");
  const hasPricing = violations.includes("pricing");
  const reply =
    hasBooking && hasPricing
      ? SAFE_BOTH_REPLY
      : hasBooking
        ? SAFE_BOOKING_REPLY
        : SAFE_PRICING_REPLY;

  return { safe: false, reply, violations };
}
