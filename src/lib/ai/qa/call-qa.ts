/**
 * Neutral QA aggregation (Avoca Stage 5/6 backbone). PURE — composes the
 * deterministic transcript flags (Stage 8) with the optional LLM judge scores
 * (Stage 6) into one call-QA summary, WITHOUT imposing any rubric weighting
 * (per-org weighting is Stage 7, operator-configurable — out of scope here).
 *
 * It derives only two org-INDEPENDENT things:
 *  - `hardFail`: any safety violation present (the output-guardrail hard-property
 *    model — a price leak / false booking / dangerous-DIY / fabricated credential
 *    is a fail regardless of rubric). Violations are the UNION of the deterministic
 *    flags and the judge's own detections (defense-in-depth).
 *  - `coachingGaps`: missed positive behaviors (greeting, booking attempt) — these
 *    are advisory coaching signals, NOT hard fails.
 * The judge's 1–5 scores are passed through unweighted for the cockpit/rubric layer.
 */
import type { TranscriptQaFlags } from "./transcript-flags";
import type { JudgeScores } from "@/lib/ai/eval/judge";

export type CallQaViolation = "pricing" | "false-booking" | "dangerous-diy" | "credentials";
export type CallQaGap = "no-greeting" | "no-booking-attempt";

export interface CallQaSummary {
  readonly hardFail: boolean;
  readonly violations: readonly CallQaViolation[];
  readonly coachingGaps: readonly CallQaGap[];
  /** Judge scores passed through unweighted (null when the judge didn't run). */
  readonly judge: JudgeScores | null;
}

export function summarizeCallQa(
  flags: TranscriptQaFlags,
  judge: JudgeScores | null = null,
): CallQaSummary {
  const violations: CallQaViolation[] = [];
  // Union the deterministic flags with the judge's own detections.
  if (flags.priceQuoted || judge?.pricingLeak) violations.push("pricing");
  if (flags.falseBooking || judge?.falseBooking) violations.push("false-booking");
  if (flags.dangerousDiy) violations.push("dangerous-diy");
  if (flags.credentialClaim) violations.push("credentials");

  const coachingGaps: CallQaGap[] = [];
  if (!flags.greetingGiven) coachingGaps.push("no-greeting");
  if (!flags.bookingAttempted) coachingGaps.push("no-booking-attempt");

  return {
    hardFail: violations.length > 0,
    violations,
    coachingGaps,
    judge,
  };
}
