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

/** A committed dollar amount with the symbol: "$200", "$ 1,200", "costs $99". */
export const PRICE_REGEX = /\$\s?\d/;

/**
 * A spoken/written dollar amount WITHOUT the "$" symbol: "200 dollars", "fifty
 * bucks", "two hundred dollars", "1,200 dollars". TTS never renders a literal
 * "$", so on the voice channel the model is MORE likely to emit these forms —
 * {@link PRICE_REGEX} alone misses them. To keep false positives near zero, a
 * number (digits OR number-words) must sit CONTIGUOUSLY before "dollars"/"bucks"
 * (only spaces/hyphens between), so "ten years … we accept dollars" does NOT
 * match. (Residual gap: a bare "two-fifty" with no currency word still slips
 * through — acceptable; the currency word is what makes a match unambiguous.)
 */
export const PRICE_WORD_REGEX =
  /\b(?:\d[\d,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand)(?:[\s-](?:hundred|thousand|grand|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))*[\s-]*(?:dollars?|bucks)\b/i;

/**
 * A false-booking claim — language that asserts a confirmed appointment. The bot
 * offers windows and collects details; it never confirms a booking itself.
 *
 * Covers three tenses so the most NATURAL LLM confirmations don't slip through
 * (review — the present-tense-only regex missed all of these):
 *  - present:  "you're booked", "your appointment is confirmed"
 *  - active perfect: "I've booked you", "we've got you scheduled"
 *  - passive perfect: "you've been booked", "your appointment has been confirmed"
 * Anchored so OFFERS/negations/future forms ("I can get you booked", "I'll have
 * our team confirm", "I haven't reserved a slot yet") do NOT match.
 */
export const FALSE_BOOKING_REGEX =
  /\b(you(?:'?re| are)\s+(?:all\s+)?(?:booked|scheduled)|is (?:booked|scheduled)|confirmed for|appointment is (set|booked|scheduled|confirmed)|booking is confirmed|(?:I|we)(?:'?ve| have)\s+(?:(?:booked|scheduled|reserved)\s+(?:you|your)|got\s+you\s+(?:booked|scheduled))|you(?:'?ve| have)\s+been\s+(?:booked|scheduled|reserved)|your\s+(?:appointment|visit|service|booking|slot|spot)\s+has\s+been\s+(?:booked|scheduled|confirmed|reserved)|your\s+(?:appointment|visit|service|booking)\s+is\s+(?:all\s+)?(?:set|booked|scheduled|confirmed))\b/i;

/**
 * Dangerous-DIY instruction detector — anchored on IMPERATIVE / HOW-TO phrasing
 * combined with actions that require professional licensing (refrigerant handling,
 * gas/pilot relight, capacitor/high-voltage work, wiring).
 *
 * Design intent — LOW FALSE POSITIVES:
 * - General explanations ("a capacitor helps the motor start", "low refrigerant
 *   causes icing") must NOT match.
 * - Only the how-to form matches: an action verb paired with the dangerous topic,
 *   OR phrasing that explicitly sets up step-by-step instructions.
 * - Technician-framed actions ("a tech will recharge the system", "can replace the
 *   capacitor") must NOT match — negative lookbehind on will/can/could/should/
 *   would/may/to preceding the dangerous verb.
 *
 * Covered patterns (per spec):
 *   1. Refrigerant recharge/charge + gauge/valve/freon action phrasing
 *   2. Pilot relight steps (turn/set gas valve + pilot + igniter context)
 *   3. Capacitor discharge/replace step instructions
 *   4. High-voltage wiring / contactor wiring steps
 *   5. "here's how to" / "how to" framing for any of the above dangerous actions
 *   6. top off refrigerant/freon
 *   7. hook up / attach gauges
 *   8. charge it up
 *   9. swap contactor/capacitor/compressor
 *  10. short capacitor / terminals
 *  11. pop capacitor
 *  12. light the pilot / hold knob down / set dial to pilot / press ignition
 */
export const DANGEROUS_DIY_REGEX =
  /(?:connect(?:ing)?\s+(?:the\s+)?(?:gauge|manifold|hose|service\s+port|low[- ]side|high[- ]side)|top\s+off\s+(?:the\s+|your\s+)?(?:refrigerant|freon|r-?(?:22|410a?|454b?)|coolant)|add(?:ing)?(?:\s+\w+){0,3}\s+(?:refrigerant|freon|r-?(?:22|410a?|454b?)|coolant)\b|\byou\s+(?:can|could|should|would|might)\s+recharge|(?<!(?:will|can|could|should|would|may|to)\s)recharge\s+your\s+(?:refrigerant|freon|system|ac|a\/c)|(?<!(?:will|can|could|should|would|may|to|and)\s)recharge\s+the\s+(?:refrigerant|freon|system|ac|a\/c|unit)|hook(?:ing)?\s+up\s+(?:the\s+)?(?:manifold|gauge|hose)|attach(?:ing)?\s+(?:the\s+|your\s+)?gauge|charge\s+it\s+up|swap\s+(?:the\s+)?(?:contactor|capacitor|compressor)|short(?:ing)?\s+(?:the\s+)?(?:capacitor\s+)?(?:capacitor|terminals?)|pop\s+(?:the\s+)?capacitor|turn\s+(?:the\s+)?gas\s+valve\s+to\s+pilot|hold\s+(?:the\s+)?(?:igniter|pilot|reset)\s+(?:button|down|for)|hold\s+(?:the\s+)?knob\s+down|relight\s+(?:the\s+)?pilot|light\s+the\s+pilot|set\s+the\s+dial\s+to\s+pilot|press\s+the\s+ignition|discharge\s+(?:the\s+)?capacitor|(?<!(?:will|can|could|should|would|may|to)\s)(?:remove|replace|unscrew|disconnect)\s+(?:the\s+)?capacitor|wire\s+(?:the\s+)?(?:new\s+)?(?:contactor|capacitor|compressor|breaker|disconnect)|connect\s+(?:the\s+)?(?:l1|l2|l-1|l-2|line\s+terminal|load\s+terminal|high\s+voltage)|how\s+to\s+(?:recharge|relight|wire|discharge|replace\s+(?:the\s+|a\s+)?capacitor|handle\s+refrigerant)|here'?s\s+how\s+to\s+(?:recharge|relight|wire|discharge|replace\s+(?:the\s+|a\s+)?capacitor)|steps?\s+to\s+(?:recharge|relight|replace\s+(?:the\s+|a\s+)?capacitor|wire))/i;

/**
 * Fabricated-credentials detector — first-person claims of professional
 * certification or qualification the bot does not hold.
 *
 * Matches: "I'm EPA-certified", "I'm a licensed technician", "I'm NATE-certified",
 * "I'm a certified technician", "I'm qualified to".
 * Does NOT match third-person talk about technician credentials.
 */
export const CREDENTIAL_REGEX =
  /\bI(?:'?m| am)\s+(?:a\s+|an\s+)?(?:EPA[-\s]certified|NATE[-\s]certified|licensed\s+(?:technician|HVAC|contractor|professional)|certified\s+(?:technician|HVAC|contractor|professional)|qualified\s+to)\b/i;

export type ReplyViolation = "pricing" | "false-booking" | "dangerous-diy" | "credentials";

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
// NOTE: this replacement must not trip DANGEROUS_DIY_REGEX, CREDENTIAL_REGEX,
// PRICE_REGEX, or FALSE_BOOKING_REGEX.
const SAFE_DIY_REPLY =
  "That's something a licensed technician should handle safely — I can get one out to you, or our team can walk you through it. Want me to set that up?";

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
  if (PRICE_REGEX.test(text) || PRICE_WORD_REGEX.test(text)) violations.push("pricing");
  if (FALSE_BOOKING_REGEX.test(text)) violations.push("false-booking");
  if (DANGEROUS_DIY_REGEX.test(text)) violations.push("dangerous-diy");
  if (CREDENTIAL_REGEX.test(text)) violations.push("credentials");

  if (violations.length === 0) {
    return { safe: true, reply: text, violations };
  }

  // Dangerous-DIY and credentials get their own replacement, checked first
  // since they are the highest-safety-risk violations.
  if (violations.includes("dangerous-diy") || violations.includes("credentials")) {
    return { safe: false, reply: SAFE_DIY_REPLY, violations };
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
