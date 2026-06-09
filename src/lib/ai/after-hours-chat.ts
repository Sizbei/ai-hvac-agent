/**
 * Customer-facing after-hours flow for the chat intake.
 *
 * The fee ENGINE (isAfterHours / computeSurcharge) lives in
 * `@/lib/admin/after-hours` and already flags `isAfterHours` + a surcharge on
 * the service request at confirm time. The GAP this helper closes is purely
 * conversational: when an intake happens outside the org's business hours, the
 * bot should (a) ask whether the situation is urgent, (b) if urgent, disclose
 * that an after-hours service charge applies — WITHOUT quoting a dollar amount
 * (the engine still computes the number at confirm), and (c) if NOT urgent,
 * offer a next-business-day visit at no after-hours charge.
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
}

// Copy is intentionally NUMBER-FREE: we never quote the fee (the engine still
// computes it at confirm). Phrasing matches the warm, uptime-driven B2B voice.
const ASK_URGENCY_COPY =
  "Since it's after our normal hours, is this urgent or can it wait until our next business day?";

const DISCLOSE_CHARGE_COPY =
  "Since it's after our normal hours, there's an additional after-hours service charge, and our team will confirm the details. Let's get the rest of your information so we can get someone out to you.";

const OFFER_NEXT_DAY_COPY =
  "No problem — I can set you up for our next business day at no after-hours charge. Want me to do that?";

/** Urgency levels that count as "urgent enough" to skip the ask + disclose. */
function isUrgentUrgency(urgency: Urgency | null): boolean {
  return urgency === "emergency" || urgency === "high";
}

/**
 * Decide the after-hours conversational move for the current turn.
 *
 * - Business hours (or pricing disabled): `"none"` — no charge talk at all.
 * - After-hours + clearly urgent (emergency/high urgency, OR the customer
 *   confirmed "yes"): `"disclose_charge"` (no dollar amount).
 * - After-hours + clearly not urgent (customer said it can wait): `"offer_next_day"`.
 * - After-hours + urgency still unknown: `"ask_urgency"`.
 */
export function decideAfterHoursDisclosure(
  input: AfterHoursDecisionInput,
): AfterHoursDecision {
  const { clock, config, urgency, customerSignal } = input;

  const afterHours = isAfterHours(clock, config);
  if (!afterHours) {
    return { kind: "none", afterHours: false, copy: "" };
  }

  // Urgent: either we already classified it high/emergency, or the customer
  // explicitly confirmed it's urgent in response to the ask.
  if (isUrgentUrgency(urgency) || customerSignal === "urgent") {
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
