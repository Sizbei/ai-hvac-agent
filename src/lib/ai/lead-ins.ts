/**
 * Conversational warmth lead-ins for the DETERMINISTIC (0-token) intake path.
 *
 * The deterministic next-question replies (nextSlotPrompt / canned COLLECT_INFO
 * asks) are correct but terse. This module supplies a short, template-based
 * acknowledgement of the customer's stated issue to prepend before the next
 * question — adding warmth WITHOUT an LLM call (it stays 0-token).
 *
 * Design constraints:
 *  - Pure, deterministic, no I/O — picks a lead-in from a fixed table using the
 *    known issueType and a rotating index so it isn't repetitive turn-to-turn.
 *  - EMERGENCIES are NEVER softened here: the caller must not invoke this for an
 *    emergency-urgency turn (the safety copy is exact and owned elsewhere).
 *  - Returns "" when there's nothing meaningful to acknowledge (no issue known),
 *    so the next question is sent unchanged rather than with a hollow filler.
 */
import type { IssueType, Urgency } from "./router-types";

// Per-issue acknowledgement variants. Each is a complete short sentence ending
// in a space-safe separator the caller can concatenate before the question.
// Kept empathetic + competent, never apologetic or self-doubting.
const ISSUE_LEAD_INS: Record<IssueType, readonly string[]> = {
  cooling_not_working: [
    "That sounds uncomfortable — let's get your cooling sorted.",
    "No cool air is no fun, especially on a warm day. We'll get someone out to you.",
    "Got it — a system that won't cool needs a look. Let's line that up.",
  ],
  heating_not_working: [
    "A cold house is the last thing you need — let's get your heat back.",
    "Understood, losing heat is rough. We'll get a technician on it.",
    "Got it — no heat is a priority for us. Let's get this moving.",
  ],
  thermostat_issue: [
    "Thermostat trouble can throw off the whole system — let's pin it down.",
    "Got it — a thermostat acting up is worth a proper look. Let's set that up.",
    "Understood. We'll get the thermostat checked out.",
  ],
  air_quality: [
    "Air quality matters for everyone at home — let's get this addressed.",
    "Got it — we'll get someone out to look at your air quality.",
    "Understood. Let's get to the bottom of the air quality issue.",
  ],
  strange_noises: [
    "Odd noises are worth catching early — let's get it checked.",
    "Got it — a noisy system shouldn't be ignored. Let's line up a visit.",
    "Understood. We'll have a technician track down that noise.",
  ],
  water_leak: [
    "A leak is good to handle promptly — let's get a technician out.",
    "Got it — we'll get that leak looked at before it spreads.",
    "Understood. Let's get someone to your leak quickly.",
  ],
  maintenance: [
    "Happy to help you stay ahead of problems with a tune-up.",
    "Got it — regular maintenance keeps things running smoothly. Let's set it up.",
    "Great — let's get your maintenance visit scheduled.",
  ],
  installation: [
    "Exciting — let's get your new system planned out.",
    "Got it — we'll help you get the right system in place.",
    "Happy to help with your installation. Let's get the details.",
  ],
  refrigeration: [
    "A cooler that won't hold temperature puts your product at risk — let's get a tech out fast.",
    "Got it — we'll get your refrigeration looked at before it costs you inventory.",
    "Understood. Let's get someone to your cooler or freezer right away.",
  ],
  ice_machine: [
    "An ice machine down can stall your whole operation — let's get it serviced.",
    "Got it — we service the major ice machine brands. Let's line up a visit.",
    "Understood. We'll get a technician on your ice machine.",
  ],
  boiler: [
    "A boiler issue is worth handling quickly — let's get a technician out.",
    "Got it — we service gas, electric, and oil boilers. Let's set that up.",
    "Understood. Let's get your boiler looked at.",
  ],
  commercial_appliance: [
    "Down kitchen equipment slows everything down — let's get you back up and running.",
    "Got it — we'll get a technician out to your commercial appliance.",
    "Understood. Let's line up a repair on that equipment.",
  ],
  other: [
    "Thanks for letting us know — let's get a technician on it.",
    "Got it — we'll help you get this sorted.",
    "Understood. Let's line up the right help.",
  ],
};

// Generic acknowledgements when the issue type isn't known yet but the customer
// has clearly raised something — keeps the tone warm without naming the issue.
const GENERIC_LEAD_INS: readonly string[] = [
  "Thanks for the details — let's get this moving.",
  "Got it. Let's get you taken care of.",
  "Understood — we'll help you sort this out.",
];

/**
 * Build a short empathetic lead-in for a NON-emergency deterministic intake
 * reply. Returns "" for emergencies (caller must keep exact safety copy), and
 * "" when there's no issue to acknowledge AND no signal worth a generic warmth
 * line. `index` rotates the variant so successive turns aren't identical.
 */
export function leadInForIssue(
  issueType: IssueType | null | undefined,
  urgency: Urgency | null | undefined,
  index: number,
): string {
  // Never soften emergency turns — that copy is owned by the safety path.
  if (urgency === "emergency") return "";

  // Non-negative rotating index so the same issue varies turn-to-turn.
  const i = Math.abs(Math.trunc(index));

  if (issueType) {
    const variants = ISSUE_LEAD_INS[issueType];
    return variants[i % variants.length];
  }

  return "";
}

/**
 * Prepend a lead-in to a deterministic next-question reply, with a single space
 * separator. When the lead-in is empty (emergency / no issue known) the question
 * is returned unchanged, so the 0-token path is never padded with empty filler.
 */
export function withLeadIn(
  question: string,
  issueType: IssueType | null | undefined,
  urgency: Urgency | null | undefined,
  index: number,
): string {
  const lead = leadInForIssue(issueType, urgency, index);
  return lead ? `${lead} ${question}` : question;
}

export { GENERIC_LEAD_INS };
