/**
 * Customer-facing after-hours flow for the chat intake.
 *
 * The detection ENGINE (isAfterHours) lives in `@/lib/admin/after-hours` and
 * already flags `isAfterHours` on the service request at confirm time. There is
 * NO dollar surcharge — the actual charge depends on the work the team
 * performs. The GAP this helper closes is purely conversational: when an intake
 * happens outside the org's business hours, the bot should (a) ask whether the
 * situation is urgent, (b) if urgent, disclose that an after-hours service
 * charge applies — WITHOUT quoting a dollar amount (the team confirms the
 * details), and (c) if NOT urgent, offer a next-business-day visit at no
 * after-hours charge.
 *
 * This module is PURE: it takes the current instant as a `clock` Date parameter
 * (never reads Date.now()) and the org's already-resolved AfterHoursConfig, so
 * it unit-tests deterministically with no DB and no wall-clock dependency.
 *
 * It never decides EMERGENCIES — a true hazard is handled upstream on the
 * existing safety/escalation path before this runs, so we never delay help to
 * talk about charges.
 */
import { isAfterHours, type AfterHoursConfig } from "@/lib/admin/after-hours";
import type { Urgency } from "./router-types";

/**
 * What, if anything, the customer explicitly told us about urgency in response
 * to the after-hours ask. `"unknown"` means we haven't asked / they haven't
 * answered yet; the caller maps a yes/no quick-reply onto urgent/not_urgent.
 */
export type CustomerUrgencySignal = "unknown" | "urgent" | "not_urgent";

/**
 * When does the customer actually want the SERVICE to happen? The after-hours
 * charge is about WHEN THE TECHNICIAN GOES OUT, not when the customer happens to
 * be chatting. A customer messaging at 11pm who wants someone "tomorrow morning"
 * is booking BUSINESS HOURS — no after-hours charge applies.
 *
 * - `"now"`: the customer wants service immediately / tonight / ASAP.
 * - `"business_hours"`: the customer wants a next-business-day / morning /
 *   afternoon / evening visit — i.e. during normal hours, so NO charge.
 * - `"unknown"`: we don't yet know; fall back to urgency classification.
 *
 * NOTE: this is deliberately NOT a real appointment time — there is no calendar
 * booking in scope yet. It's the best available proxy (the customer's stated
 * preferred window / urgency intent), and it lets us avoid threatening a charge
 * for a request that will plainly be serviced during business hours.
 */
export type BookingTarget = "unknown" | "now" | "business_hours";

/** The conversational move to make this turn. */
export type AfterHoursDecisionKind =
  // Not after-hours (or pricing disabled) — say nothing about charges.
  | "none"
  // After-hours, urgency not yet known — ask whether it's urgent.
  | "ask_urgency"
  // After-hours + urgent — proceed with intake AND disclose the charge.
  | "disclose_charge"
  // After-hours + not urgent — offer a no-charge next-business-day visit.
  | "offer_next_day";

export interface AfterHoursDecision {
  readonly kind: AfterHoursDecisionKind;
  /** Whether the instant falls in the org's after-hours window. */
  readonly afterHours: boolean;
  /** Customer-facing copy to surface (empty for `"none"`). NEVER contains a
   * dollar amount — the disclosure is deliberately number-free. */
  readonly copy: string;
}

export interface AfterHoursDecisionInput {
  /** The current instant — passed in so the helper stays pure/testable. */
  readonly clock: Date;
  /** The org's resolved after-hours config (timezone-aware window). */
  readonly config: AfterHoursConfig;
  /** Best-known urgency for this request (router/extraction), or null. */
  readonly urgency: Urgency | null;
  /** What the customer answered to the urgency ask, if anything. */
  readonly customerSignal: CustomerUrgencySignal;
  /**
   * When the SERVICE is targeted to happen, inferred from the customer's stated
   * preferred window / intent. Optional for backwards compatibility; defaults to
   * `"unknown"`. When this is `"business_hours"` we NEVER disclose an
   * after-hours charge — the visit is during normal hours, so no charge applies.
   */
  readonly bookingTarget?: BookingTarget;
}

// Copy is intentionally NUMBER-FREE: we never quote the fee (the engine still
// computes it at confirm). Phrasing matches the warm, uptime-driven B2B voice.
const ASK_URGENCY_COPY =
  "Since it's after our normal hours, is this urgent or can it wait until our next business day?";

const DISCLOSE_CHARGE_COPY =
  "Since it's after our normal hours, there's an additional after-hours service charge, and our team will confirm the details. Let's get the rest of your information so we can get someone out to you.";

const OFFER_NEXT_DAY_COPY =
  "No problem. I can set you up for our next business day at no after-hours charge. Want me to do that?";

// Used when the customer has stated a business-hours window (e.g. tomorrow
// morning) WHILE we still need more intake info. We affirm the no-charge framing
// up front so a surprise fee never appears later; the next intake question is
// appended by the caller. Like the others, it is number-free.
const BUSINESS_HOURS_BOOKING_COPY =
  "Great. Since that's during our normal business hours, there's no after-hours charge.";

/** Urgency levels that count as "urgent enough" to skip the ask + disclose. */
function isUrgentUrgency(urgency: Urgency | null): boolean {
  return urgency === "emergency" || urgency === "high";
}

/**
 * Decide the after-hours conversational move for the current turn.
 *
 * - Business hours (or pricing disabled): `"none"` — no charge talk at all.
 * - After-hours but the SERVICE is targeted for business hours (the customer
 *   wants tomorrow morning / a normal-hours window): `"offer_next_day"` with a
 *   NO-charge affirmation. The charge is keyed to when the technician goes out,
 *   not when the customer is chatting, so a business-hours visit never incurs
 *   one. This branch wins even over a high urgency classification, because an
 *   explicit "tomorrow morning is fine" is a stronger signal than a heuristic.
 * - After-hours + the service is wanted NOW / clearly urgent (emergency/high
 *   urgency, the customer confirmed "yes", OR they asked for tonight/ASAP):
 *   `"disclose_charge"` (no dollar amount).
 * - After-hours + clearly not urgent (customer said it can wait): `"offer_next_day"`.
 * - After-hours + urgency still unknown: `"ask_urgency"`.
 *
 * KEY GUARANTEE (Fix 2): we only ever disclose an after-hours charge when the
 * request is genuinely for NOW. A next-business-day / morning booking is treated
 * as a normal business-hours visit with no charge, so a customer chatting at
 * 11pm for a tomorrow-morning appointment is never threatened with a fee.
 */
/**
 * Derive the best-available booking target from the customer's stated preferred
 * window and urgency signal — the proxy `decideAfterHoursDisclosure` uses to
 * avoid threatening an after-hours charge for a request that will plainly be
 * serviced during business hours (Fix 2). Shared by both the web chat and the
 * voice agent so the two channels agree.
 *
 * A stated daytime window ("morning"/"afternoon"/"evening") maps to
 * `business_hours` and deliberately OVERRIDES the urgency heuristic; `"asap"`
 * maps to `now`. With no window, we fall back to the urgency signal. Anything
 * else is `"unknown"` (the helper then leans on urgency classification).
 */
export function inferBookingTarget(
  preferredWindow: unknown,
  customerSignal: CustomerUrgencySignal,
): BookingTarget {
  if (preferredWindow === "asap") return "now";
  if (
    preferredWindow === "morning" ||
    preferredWindow === "afternoon" ||
    preferredWindow === "evening"
  ) {
    return "business_hours";
  }
  if (customerSignal === "not_urgent") return "business_hours";
  if (customerSignal === "urgent") return "now";
  return "unknown";
}

export function decideAfterHoursDisclosure(
  input: AfterHoursDecisionInput,
): AfterHoursDecision {
  const { clock, config, urgency, customerSignal } = input;
  const bookingTarget: BookingTarget = input.bookingTarget ?? "unknown";

  const afterHours = isAfterHours(clock, config);
  if (!afterHours) {
    return { kind: "none", afterHours: false, copy: "" };
  }

  // The booking is explicitly for business hours (e.g. "tomorrow morning"):
  // no after-hours charge applies. This OVERRIDES the urgency heuristic — an
  // explicit next-day window is the customer telling us it can wait. We affirm
  // the no-charge framing so a surprise fee never surfaces later in the intake.
  if (bookingTarget === "business_hours") {
    return {
      kind: "offer_next_day",
      afterHours: true,
      copy: BUSINESS_HOURS_BOOKING_COPY,
    };
  }

  // Urgent: either we already classified it high/emergency, the customer
  // explicitly confirmed it's urgent in response to the ask, OR they asked for
  // service now/tonight/ASAP. The service really is happening after hours.
  if (
    isUrgentUrgency(urgency) ||
    customerSignal === "urgent" ||
    bookingTarget === "now"
  ) {
    return {
      kind: "disclose_charge",
      afterHours: true,
      copy: DISCLOSE_CHARGE_COPY,
    };
  }

  // Explicitly not urgent: the customer said it can wait → offer next day.
  if (customerSignal === "not_urgent") {
    return {
      kind: "offer_next_day",
      afterHours: true,
      copy: OFFER_NEXT_DAY_COPY,
    };
  }

  // Otherwise we don't yet know — ask.
  return { kind: "ask_urgency", afterHours: true, copy: ASK_URGENCY_COPY };
}

/**
 * LLM coaching for after-hours turns (brain-unification D4: was inline in the
 * chat route; both brains' fallback paths now share it). A SEPARATE block
 * rather than an edit to the brand persona; safety always wins over charge talk.
 */
export const AFTER_HOURS_LLM_INSTRUCTION = `

AFTER-HOURS (it is currently outside our normal business hours): Before fully committing to dispatch, find out whether the situation is urgent — UNLESS it's already clearly an emergency or high-urgency (then skip the question and treat it as urgent). If it IS urgent (or the customer confirms yes): continue the intake AND let them know that, since it's after our normal hours, an additional after-hours service charge applies and our team will confirm the details. NEVER state a dollar amount or quote a price — just that a charge applies. If it is NOT urgent: offer to set them up for our next business day at no after-hours charge, and continue accordingly. SAFETY ALWAYS WINS: if there's any hazard (gas/CO/electrical/flooding), follow the safety instructions above and connect them to a person immediately — never delay a hazard to discuss charges.`;

/** Suppression note once a disclosure was already made on a deterministic turn —
 * re-explaining the charge every LLM turn is the repetition bug in another coat. */
export const AFTER_HOURS_SUPPRESS_INSTRUCTION =
  "\nAFTER-HOURS: the after-hours situation has ALREADY been explained to this customer. Do NOT bring up after-hours charges or hours again unless the customer asks.";

/**
 * Interpret a customer's reply to the after-hours "is this urgent?" ask as a
 * yes/no signal (brain-unification D4: was inline in the chat route). Only
 * meaningful when we ASKED last turn; otherwise "unknown" lets urgency
 * classification drive the decision. Conservative: only clear
 * affirmatives/negatives flip it.
 */
export function readUrgencySignal(
  askedUrgencyLastTurn: boolean,
  message: string,
): CustomerUrgencySignal {
  if (!askedUrgencyLastTurn) return "unknown";
  const m = message.trim().toLowerCase();
  // Negated urgency FIRST — otherwise the affirmative check below matches the
  // substring "urgent"/"emergency" inside "not urgent" / "not an emergency" and
  // flips a clear no into a yes. Scoped to explicit negation so a contradictory
  // "no, it's an emergency" (where "no" answers "can it wait?") still reads urgent.
  if (/\b(not|isn'?t|no)\s+(an?\s+)?(urgent|emergency)\b/.test(m)) {
    return "not_urgent";
  }
  if (
    /\b(urgent|emergency|asap|right now|today|tonight|now|yes|yeah|yep|please do)\b/.test(
      m,
    ) ||
    /can'?t wait/.test(m)
  ) {
    return "urgent";
  }
  if (
    /\b(no|nope|not urgent|tomorrow|next day|morning|can wait|whenever|no rush)\b/.test(
      m,
    )
  ) {
    return "not_urgent";
  }
  return "unknown";
}
