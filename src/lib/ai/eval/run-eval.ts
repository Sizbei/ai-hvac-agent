/**
 * Deterministic eval runner (CHATBOT-PLAN Step 8, layer 1).
 *
 * Replays each golden transcript through the PURE deterministic surface
 * (`routeMessage` + `sanitizeInput`) and computes pass/fail checks WITHOUT any
 * LLM call, DB, or network. This is what gates CI (see eval.test.ts).
 *
 * Slot accretion: a real chat accumulates slots across turns. We simulate that
 * deterministically — after each verdict we fold the verdict's issueType/urgency
 * into the running slots, and we heuristically detect an address turn (so a
 * normal intake transcript can legitimately promote COLLECT_INFO → SUBMIT). We
 * do NOT call the extraction LLM; the heuristic is intentionally conservative
 * (it only sets fields the router itself reads: issueType, urgency, address).
 */
import { routeMessage, type KnownSlots, type RouterVerdict } from "../intent-router";
import { EMPTY_ORG_CONFIG } from "../router-config";
import { sanitizeInput, type GuardrailResult } from "../guardrails";
import type { SlotName } from "../router-types";
import { buildWindowPrompt } from "../availability-prompt";
import type { OpenAvailability } from "@/lib/admin/types";
import {
  GOLDEN_TRANSCRIPTS,
  type GoldenTranscript,
} from "./golden-transcripts";

/** Sample REAL availability the window-offer check exercises buildWindowPrompt
 * against — two open bands across two business days. */
const SAMPLE_AVAILABILITY: OpenAvailability = {
  days: ["2026-07-07", "2026-07-08"],
  windows: [
    { day: "2026-07-07", window: "morning", capacity: 2, available: 1 },
    { day: "2026-07-08", window: "afternoon", capacity: 2, available: 2 },
  ],
};

/** Detects a committed dollar amount like "$200", "$ 1,200", "costs $99". */
const PRICE_REGEX = /\$\s?\d/;
/** Detects a false-booking claim in a served reply. */
const FALSE_BOOKING_REGEX =
  /\b(you'?re booked|is booked|you'?re scheduled|is scheduled|confirmed for|appointment is (set|booked|scheduled|confirmed)|booking is confirmed)\b/i;
/** Naive address heuristic: a street number + a street-ish word. */
const ADDRESS_REGEX = /\b\d{1,6}\s+\w+(\s+\w+)*\b/;
const ADDRESS_HINT = /(street|st\b|ave|avenue|road|rd\b|lane|ln\b|drive|dr\b|blvd|way|court|ct\b)/i;

export interface TurnTrace {
  readonly turnIndex: number;
  readonly input: string;
  readonly guardrail: GuardrailResult;
  /** The deterministic verdict, or null when the turn was hard-blocked (no served reply). */
  readonly verdict: RouterVerdict | null;
}

export type CheckId =
  | "pricing-leak"
  | "false-booking"
  | "emergency-escalation"
  | "expected-intent"
  | "expected-action"
  | "injection-block"
  | "reach-submit"
  | "account-recognition"
  | "re-ask-loop"
  | "window-offer-preference"
  | "ambiguity-probe"
  | "reply-contains";

export interface CheckResult {
  readonly id: CheckId;
  readonly pass: boolean;
  /** True for safety checks whose failure must fail CI hard. */
  readonly critical: boolean;
  readonly detail: string;
}

export interface TranscriptResult {
  readonly id: string;
  readonly category: string;
  readonly turns: readonly TurnTrace[];
  readonly checks: readonly CheckResult[];
  readonly pass: boolean;
  readonly criticalFailures: number;
  /** 0..1 — fraction of applicable checks that passed. */
  readonly score: number;
}

export interface EvalReport {
  readonly results: readonly TranscriptResult[];
  readonly total: number;
  readonly passed: number;
  readonly criticalFailures: number;
  /** Mean of per-transcript scores, 0..1. */
  readonly aggregateScore: number;
}

/** Critical checks — a failure here is a hard CI failure (safety properties). */
const CRITICAL_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  "pricing-leak",
  "false-booking",
  "emergency-escalation",
  "injection-block",
  // The window OFFER must never leak commitment language — it's the same
  // offer-not-commit safety property the false-booking gate enforces.
  "window-offer-preference",
]);

/** The slots the deterministic router actually reads. */
function foldVerdictIntoSlots(slots: KnownSlots, v: RouterVerdict): KnownSlots {
  return {
    ...slots,
    issueType: slots.issueType ?? v.issueType ?? null,
    urgency: slots.urgency ?? v.urgency ?? null,
  };
}

function detectAddress(input: string): string | null {
  if (ADDRESS_REGEX.test(input) && ADDRESS_HINT.test(input)) return input.trim();
  return null;
}

/** Replay one transcript's turns, returning the per-turn trace. */
function replay(transcript: GoldenTranscript): TurnTrace[] {
  let slots: KnownSlots = { ...(transcript.initialSlots ?? {}) };
  const traces: TurnTrace[] = [];

  const config = transcript.orgConfig ?? EMPTY_ORG_CONFIG;

  transcript.userTurns.forEach((input, turnIndex) => {
    const guardrail = sanitizeInput(input);

    // A HARD injection never reaches a served reply — the route returns the
    // hard block. We model that here as "no verdict" so the eval can assert the
    // input never produced a canned/served answer. SOFT flags and clean input
    // proceed to the router (the route answers conversationally on SOFT).
    if (guardrail.severity === "hard") {
      traces.push({ turnIndex, input, guardrail, verdict: null });
      return;
    }

    // Accrete an address from this turn before routing so the SUBMIT promotion
    // (which the router does when all required slots are present) can fire.
    const addr = detectAddress(guardrail.sanitized);
    if (addr) slots = { ...slots, address: addr };

    const verdict = routeMessage(guardrail.sanitized, slots, config);
    slots = foldVerdictIntoSlots(slots, verdict);

    traces.push({ turnIndex, input, guardrail, verdict });
  });

  return traces;
}

function servedReplies(traces: readonly TurnTrace[]): string[] {
  return traces
    .map((t) => t.verdict?.reply)
    .filter((r): r is string => typeof r === "string" && r.length > 0);
}

/** Count how many times each required slot is asked (COLLECT_INFO turns). */
function reAskCounts(traces: readonly TurnTrace[]): Map<SlotName, number> {
  const counts = new Map<SlotName, number>();
  for (const t of traces) {
    if (t.verdict?.action === "COLLECT_INFO") {
      // The router asks for the next missing required slot; without exposing
      // which one, we count COLLECT_INFO turns as a proxy for re-asks of the
      // intake. This catches an intake that loops without progressing.
      counts.set("issueType", (counts.get("issueType") ?? 0) + 1);
    }
  }
  return counts;
}

function evaluate(transcript: GoldenTranscript, traces: readonly TurnTrace[]): CheckResult[] {
  const checks: CheckResult[] = [];
  const exp = transcript.expect;
  const replies = servedReplies(traces);
  const finalVerdict = [...traces].reverse().find((t) => t.verdict)?.verdict ?? null;
  const anyEscalate = traces.some((t) => t.verdict?.escalate === true);
  const anyHardBlock = traces.some((t) => t.guardrail.severity === "hard");
  const anyAccountLookup = traces.some((t) => t.verdict?.action === "ACCOUNT_LOOKUP");
  const reachedSubmit = traces.some((t) => t.verdict?.action === "SUBMIT");

  const add = (id: CheckId, pass: boolean, detail: string) =>
    checks.push({ id, pass, critical: CRITICAL_CHECKS.has(id), detail });

  // pricing-leak (critical) — no served reply may contain a committed price.
  if (exp.noPriceLeak) {
    const leak = replies.find((r) => PRICE_REGEX.test(r));
    add("pricing-leak", leak === undefined, leak ? `leaked price in: "${leak}"` : "no committed price");
  }

  // false-booking (critical) — no served reply may claim booked/scheduled/confirmed.
  if (exp.noFalseBooking) {
    const booked = replies.find((r) => FALSE_BOOKING_REGEX.test(r));
    add("false-booking", booked === undefined, booked ? `false booking in: "${booked}"` : "no false booking");
  }

  // emergency-escalation (critical) — emergency transcripts must escalate.
  if (exp.mustEscalate) {
    add("emergency-escalation", anyEscalate, anyEscalate ? "escalated" : "FAILED to escalate emergency");
  }

  // injection-block (critical) — flagged inputs must hard-block (no served reply).
  if (exp.mustHardBlock) {
    const noServedReply = traces
      .filter((t) => t.guardrail.severity === "hard")
      .every((t) => t.verdict === null);
    add(
      "injection-block",
      anyHardBlock && noServedReply,
      anyHardBlock ? (noServedReply ? "hard-blocked, no served reply" : "BYPASS: served a reply") : "NOT flagged as hard",
    );
  }

  // expected-action (non-critical) — final turn action matches.
  if (exp.finalAction) {
    add(
      "expected-action",
      finalVerdict?.action === exp.finalAction,
      `final action=${finalVerdict?.action ?? "none"} expected=${exp.finalAction}`,
    );
  }

  // expected-intent (non-critical) — final turn intentId matches.
  if (exp.finalIntentId) {
    add(
      "expected-intent",
      finalVerdict?.intentId === exp.finalIntentId,
      `final intentId=${finalVerdict?.intentId ?? "none"} expected=${exp.finalIntentId}`,
    );
  }

  // reach-submit (non-critical) — a normal intake must reach SUBMIT-ready.
  if (exp.mustReachSubmit) {
    add("reach-submit", reachedSubmit, reachedSubmit ? "reached SUBMIT" : "never reached SUBMIT");
  }

  // account-recognition (non-critical) — identity-gated read recognized.
  if (exp.mustRecognizeAccount) {
    add("account-recognition", anyAccountLookup, anyAccountLookup ? "ACCOUNT_LOOKUP recognized" : "not recognized");
  }

  // re-ask-loop (non-critical) — no slot asked more than maxReAsk times.
  if (exp.maxReAsk !== undefined) {
    const counts = reAskCounts(traces);
    const worst = Math.max(0, ...counts.values());
    add("re-ask-loop", worst <= exp.maxReAsk, `max re-ask=${worst} limit=${exp.maxReAsk}`);
  }

  // window-offer-preference (critical) — the preferred-window OFFER over REAL
  // availability (Step 11+6) must be a PREFERENCE capture: it offers concrete
  // open bands, carries NO booking/price commitment, and keeps chip values on
  // the existing enum so capture stays deterministic. Exercises buildWindowPrompt
  // directly (the offer is served by the route's stepper, not by routeMessage).
  if (exp.windowOfferIsPreference) {
    const offer = buildWindowPrompt(SAMPLE_AVAILABILITY);
    const allowedValues = new Set(["morning", "afternoon", "evening", "asap"]);
    const noBookingLeak = !FALSE_BOOKING_REGEX.test(offer.question);
    const noPriceLeakOffer = !PRICE_REGEX.test(offer.question);
    const offersConcreteBand =
      offer.chips.length > 0 && offer.chips.some((c) => c.value !== "asap");
    const enumChips = offer.chips.every((c) => allowedValues.has(c.value));
    const pass =
      noBookingLeak && noPriceLeakOffer && offersConcreteBand && enumChips;
    add(
      "window-offer-preference",
      pass,
      pass
        ? "window offer is a preference (no booking/price leak, enum chips)"
        : `offer failed: booking=${!noBookingLeak} price=${!noPriceLeakOffer} concrete=${offersConcreteBand} enumChips=${enumChips} q="${offer.question}"`,
    );
  }

  // reply-contains (non-critical) — the final served reply must contain the
  // expected substring. Used by data-driven FAQ transcripts to assert the
  // configured org value (real hours / service area) actually surfaces.
  if (exp.finalReplyContains) {
    const reply = finalVerdict?.reply ?? "";
    const has = reply.toLowerCase().includes(exp.finalReplyContains.toLowerCase());
    add(
      "reply-contains",
      has,
      has
        ? `reply contains "${exp.finalReplyContains}"`
        : `reply "${reply}" missing "${exp.finalReplyContains}"`,
    );
  }

  // ambiguity-probe (non-critical) — a vague/ambiguous message must produce a
  // deterministic CLARIFY probe (Step 16), not punt to the LLM.
  if (exp.mustProbeAmbiguity) {
    const probed = finalVerdict?.action === "CLARIFY";
    add(
      "ambiguity-probe",
      probed,
      probed
        ? `deterministic probe: ${finalVerdict?.intentId}`
        : `expected CLARIFY probe, got action=${finalVerdict?.action ?? "none"}`,
    );
  }

  return checks;
}

export function runTranscript(transcript: GoldenTranscript): TranscriptResult {
  const traces = replay(transcript);
  const checks = evaluate(transcript, traces);
  const criticalFailures = checks.filter((c) => c.critical && !c.pass).length;
  const passedChecks = checks.filter((c) => c.pass).length;
  const score = checks.length === 0 ? 1 : passedChecks / checks.length;
  return {
    id: transcript.id,
    category: transcript.category,
    turns: traces,
    checks,
    pass: checks.every((c) => c.pass),
    criticalFailures,
    score,
  };
}

export function runEval(
  transcripts: readonly GoldenTranscript[] = GOLDEN_TRANSCRIPTS,
): EvalReport {
  const results = transcripts.map(runTranscript);
  const passed = results.filter((r) => r.pass).length;
  const criticalFailures = results.reduce((sum, r) => sum + r.criticalFailures, 0);
  const aggregateScore =
    results.length === 0
      ? 1
      : results.reduce((sum, r) => sum + r.score, 0) / results.length;
  return { results, total: results.length, passed, criticalFailures, aggregateScore };
}

/** Pretty one-line-per-transcript summary for the CLI runner. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("Deterministic eval — golden transcripts");
  lines.push("─".repeat(60));
  for (const r of report.results) {
    const status = r.pass ? "PASS" : r.criticalFailures > 0 ? "CRIT" : "WARN";
    lines.push(
      `[${status}] ${r.id.padEnd(34)} score=${(r.score * 100).toFixed(0).padStart(3)}%  (${r.category})`,
    );
    for (const c of r.checks) {
      if (!c.pass) lines.push(`        ✗ ${c.id}${c.critical ? " (CRITICAL)" : ""}: ${c.detail}`);
    }
  }
  lines.push("─".repeat(60));
  lines.push(
    `${report.passed}/${report.total} transcripts passed · aggregate score ${(
      report.aggregateScore * 100
    ).toFixed(1)}% · critical failures: ${report.criticalFailures}`,
  );
  return lines.join("\n");
}
