/**
 * Booking-outcome classifier (Avoca revenue-moat: "QA as a downstream booking
 * label"). PURE — maps a call's existing session outcome + its QA summary into a
 * revenue-relevant bucket, a recovery-candidate flag, and (when a not-booked call
 * tripped a safety violation) the violation that may have cost it. No new signals,
 * no rubric weighting, no I/O — just a deterministic labeling over what we already
 * have. Useful to both Avoca plans (recovery targeting + coaching). Inert until wired.
 */
import type { CallQaSummary, CallQaViolation } from "./call-qa";

export type CallOutcome =
  | "booked" // a job was captured
  | "escalated" // handed to a human (not a recovery candidate)
  | "abandoned" // caller dropped before resolution
  | "unbooked" // engaged but no booking — a missed opportunity
  | "unknown";

export interface CallOutcomeResult {
  readonly outcome: CallOutcome;
  /** True when this call is worth a follow-up (missed-call / unbooked recovery). */
  readonly recoveryCandidate: boolean;
  /** On a not-booked call, the safety violation that may have cost it (else null). */
  readonly lostToViolation: CallQaViolation | null;
  readonly reasons: readonly string[];
}

export function classifyCallOutcome(input: {
  /** customer_sessions.outcome: 'booked'|'escalated'|'info_provided'|'abandoned'|'unresolved'|null */
  readonly sessionOutcome: string | null;
  readonly qa: CallQaSummary;
}): CallOutcomeResult {
  const { sessionOutcome, qa } = input;
  const reasons: string[] = [];

  let outcome: CallOutcome;
  let recoveryCandidate: boolean;
  switch (sessionOutcome) {
    case "booked":
      outcome = "booked";
      recoveryCandidate = false;
      break;
    case "escalated":
      outcome = "escalated";
      recoveryCandidate = false;
      reasons.push("handed to a human");
      break;
    case "abandoned":
      outcome = "abandoned";
      recoveryCandidate = true;
      reasons.push("caller dropped — recovery candidate");
      break;
    case "info_provided":
    case "unresolved":
      outcome = "unbooked";
      recoveryCandidate = true;
      reasons.push("engaged but did not book — recovery candidate");
      break;
    default:
      outcome = "unknown";
      recoveryCandidate = false;
  }

  // On a not-booked call that tripped a hard safety violation, surface the first
  // one as the likely-cost signal (e.g. a pricing leak on an unbooked call).
  const lostToViolation =
    outcome !== "booked" && qa.hardFail && qa.violations.length > 0 ? qa.violations[0] : null;
  if (lostToViolation) reasons.push(`possible loss driver: ${lostToViolation}`);

  return { outcome, recoveryCandidate, lostToViolation, reasons };
}
