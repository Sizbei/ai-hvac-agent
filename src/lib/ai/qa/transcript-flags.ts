/**
 * Deterministic, no-LLM QA flags over a real conversation transcript (Avoca
 * Stage 8). PURE — reuses the runtime output-guardrail detectors as the single
 * source of truth for the "violation" flags, so QA can never drift from what the
 * live guard blocks. Complements the LLM judge (Stage 6) and is free/fast.
 *
 * Operates on the AGENT's (assistant) turns — QA scores the agent's behavior.
 * Two flag classes:
 *  - violations (true = bad): the bot quoted a price, claimed a false booking,
 *    gave dangerous-DIY steps, or fabricated credentials.
 *  - positives (true = good): a greeting was given; a booking was attempted.
 */
import {
  PRICE_REGEX,
  PRICE_WORD_REGEX,
  FALSE_BOOKING_REGEX,
  DANGEROUS_DIY_REGEX,
  CREDENTIAL_REGEX,
} from "@/lib/ai/output-guardrail";
import type { ConversationMessage } from "./transcript-adapter";

export interface TranscriptQaFlags {
  /** A greeting appeared in the first agent turn. */
  readonly greetingGiven: boolean;
  /** The agent offered to schedule / get someone out. */
  readonly bookingAttempted: boolean;
  /** VIOLATION: the agent quoted a dollar amount (it must not). */
  readonly priceQuoted: boolean;
  /** VIOLATION: the agent claimed a confirmed booking. */
  readonly falseBooking: boolean;
  /** VIOLATION: the agent gave dangerous DIY instructions. */
  readonly dangerousDiy: boolean;
  /** VIOLATION: the agent fabricated a professional credential. */
  readonly credentialClaim: boolean;
}

const GREETING_REGEX =
  /\b(hi|hello|hey|welcome|thanks for calling|good (morning|afternoon|evening))\b/i;

// Booking-offer language (positive behavior). Anchored on offer/scheduling verbs
// to keep false positives low.
const BOOKING_OFFER_REGEX =
  /\b(set (that|this|it) up|get (someone|a tech\w*) (out|to you)|schedul\w+|book(?:ing|ed|s)?\b|arrival window|come out|send (someone|a tech))\b/i;

export function assessTranscriptFlags(
  messages: readonly ConversationMessage[],
): TranscriptQaFlags {
  const agentTurns = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);
  const firstAgentTurn = agentTurns[0] ?? "";
  const allAgentText = agentTurns.join("\n");

  return {
    greetingGiven: GREETING_REGEX.test(firstAgentTurn),
    bookingAttempted: BOOKING_OFFER_REGEX.test(allAgentText),
    priceQuoted: PRICE_REGEX.test(allAgentText) || PRICE_WORD_REGEX.test(allAgentText),
    falseBooking: FALSE_BOOKING_REGEX.test(allAgentText),
    dangerousDiy: DANGEROUS_DIY_REGEX.test(allAgentText),
    credentialClaim: CREDENTIAL_REGEX.test(allAgentText),
  };
}
