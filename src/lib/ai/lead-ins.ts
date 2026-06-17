/**
 * Conversational warmth lead-ins for the DETERMINISTIC (0-token) intake path.
 *
 * The deterministic next-question replies (nextSlotPrompt / canned COLLECT_INFO
 * asks) are correct but terse. This module supplies a short, template-based
 * acknowledgement of the customer's stated issue to prepend before the next
 * question — adding warmth WITHOUT an LLM call (it stays 0-token).
 *
 * EMPATHY-ONCE: a real transcript showed the bot re-acknowledging the issue on
 * EVERY collecting turn ("Got it...", "Understood...", "That sounds...") — a
 * mechanical empathy decay that reads as "too AI". The fix: emit the lead-in
 * exactly ONCE, on the first acknowledgement turn, then return "" so every
 * later question is asked plainly. The `index` passed in is the route's
 * `newTurnCount`, which starts at 1 on the first user turn, so the first turn to
 * acknowledge is `index === 1`. Any other index (including the initial greeting
 * turn before the first user reply, or later collecting turns) yields "".
 *
 * DE-TEMPLATING (Step 1): the stock "Got it." / "Understood." openers were
 * dropped — they read as filler and repeated across chats. Each issue now has a
 * small set of warm, issue-specific variants, and a `seed` rotates the choice so
 * two consecutive chats (or turns) don't open identically. The seed is the
 * route's session-derived value (a stable hash of the session id), so the
 * function stays pure and deterministic for a given (issue, seed) pair while
 * still varying across conversations.
 *
 * Design constraints:
 *  - Pure, deterministic, no I/O — picks a single lead-in from a fixed table by
 *    the known issueType and a rotation seed. Variety across issues AND chats.
 *  - EMERGENCIES are NEVER softened here: the caller must not invoke this for an
 *    emergency-urgency turn (the safety copy is exact and owned elsewhere).
 *  - Returns "" when there's nothing meaningful to acknowledge (no issue known),
 *    or once the first acknowledgement turn has passed, so the next question is
 *    sent unchanged rather than with a hollow or repeated filler.
 */
import type { IssueType, Urgency } from "./router-types";

// Per-issue acknowledgement variants. Each is a complete short sentence ending
// in a space-safe separator the caller can concatenate before the question.
// Kept empathetic + competent, never apologetic, self-doubting, or robotic.
// NOTE (Step 1): the stock "Got it." / "Understood." openers were removed — they
// read as filler and repeated identically across chats. Variants are now warm,
// issue-specific, and rotated by `seed` so consecutive chats don't read the same.
const ISSUE_LEAD_INS: Record<IssueType, readonly string[]> = {
  cooling_not_working: [
    "That sounds uncomfortable. Let's get your cooling sorted.",
    "No cool air is no fun, especially on a warm day. We'll get someone out to you.",
    "A system that won't cool needs a look, so let's line that up.",
  ],
  heating_not_working: [
    "A cold house is the last thing you need, so let's get your heat back.",
    "Losing heat is rough — we'll get a technician on it.",
    "No heat is a priority for us, so let's get this moving.",
  ],
  thermostat_issue: [
    "Thermostat trouble can throw off the whole system, so let's pin it down.",
    "A thermostat acting up is worth a proper look, so let's set that up.",
    "Let's get that thermostat checked out and back on track.",
  ],
  air_quality: [
    "Air quality matters for everyone at home, so let's get this addressed.",
    "Let's get someone out to look into your air quality.",
    "We'll get to the bottom of the air quality issue for you.",
  ],
  strange_noises: [
    "Odd noises are worth catching early, so let's get it checked.",
    "A noisy system shouldn't be ignored, so let's line up a visit.",
    "Let's have a technician track down that noise for you.",
  ],
  water_leak: [
    "A leak is good to handle promptly, so let's get a technician out.",
    "Let's get that leak looked at before it spreads.",
    "We'll get someone to your leak quickly.",
  ],
  maintenance: [
    "Happy to help you stay ahead of problems with a tune-up.",
    "Regular maintenance keeps things running smoothly, so let's set it up.",
    "Let's get your maintenance visit on the calendar.",
  ],
  installation: [
    "Exciting — let's get your new system planned out.",
    "We'll help you get the right system in place.",
    "Happy to help with your installation. Let's get the details.",
  ],
  refrigeration: [
    "A cooler that won't hold temperature puts your product at risk, so let's get a tech out fast.",
    "Let's get your refrigeration looked at before it costs you inventory.",
    "We'll get someone to your cooler or freezer right away.",
  ],
  ice_machine: [
    "An ice machine down can stall your whole operation, so let's get it serviced.",
    "We service the major ice machine brands, so let's line up a visit.",
    "Let's get a technician on your ice machine.",
  ],
  boiler: [
    "A boiler issue is worth handling quickly, so let's get a technician out.",
    "We service gas, electric, and oil boilers, so let's set that up.",
    "Let's get your boiler looked at.",
  ],
  commercial_appliance: [
    "Down kitchen equipment slows everything down, so let's get you back up and running.",
    "Let's get a technician out to your commercial appliance.",
    "Let's line up a repair on that equipment.",
  ],
  other: [
    "Thanks for letting us know. Let's get a technician on it.",
    "Let's get this taken care of for you.",
    "Let's line up the right help for you.",
  ],
};

// Generic acknowledgements when the issue type isn't known yet but the customer
// has clearly raised something — keeps the tone warm without naming the issue.
const GENERIC_LEAD_INS: readonly string[] = [
  "Thanks for the details. Let's get this moving.",
  "Let's get you taken care of.",
  "We'll help you sort this out.",
];

/** The single turn on which we acknowledge the issue. `index` is the route's
 * `newTurnCount` (1 on the first user turn), so the first acknowledgement turn
 * is turn 1. Empathy is emitted there and ONLY there. */
const ACK_TURN = 1;

/** Pick a variant by a non-negative seed, wrapping around the list. A negative
 * or non-finite seed falls back to 0 so the choice is always in range. */
function pickVariant(variants: readonly string[], seed: number): string {
  if (variants.length === 0) return "";
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const idx = ((s % variants.length) + variants.length) % variants.length;
  return variants[idx];
}

/**
 * Build a short empathetic lead-in for a NON-emergency deterministic intake
 * reply, emitted EXACTLY ONCE per conversation. Returns "":
 *  - for emergencies (caller must keep exact safety copy),
 *  - when there's no issue to acknowledge yet, and
 *  - on every turn that isn't the first acknowledgement turn (index !== 1),
 *    so later questions are asked plainly without a fresh acknowledgement.
 *
 * `index` is the route's `newTurnCount` (starts at 1 on the first user turn);
 * we acknowledge only on `index === ACK_TURN`. `seed` rotates which variant is
 * chosen so consecutive chats don't open with the same line — pass a stable
 * per-session value (e.g. a hash of the session id). Defaults to 0 for callers
 * that don't supply one (deterministic, picks the first variant).
 */
export function leadInForIssue(
  issueType: IssueType | null | undefined,
  urgency: Urgency | null | undefined,
  index: number,
  seed = 0,
): string {
  // Never soften emergency turns — that copy is owned by the safety path.
  if (urgency === "emergency") return "";

  // Empathy-once: acknowledge only on the first acknowledgement turn.
  if (Math.trunc(index) !== ACK_TURN) return "";

  if (issueType) {
    return pickVariant(ISSUE_LEAD_INS[issueType], seed);
  }

  return "";
}

/**
 * Prepend a lead-in to a deterministic next-question reply, with a single space
 * separator. When the lead-in is empty (emergency / no issue known) the question
 * is returned unchanged, so the 0-token path is never padded with empty filler.
 * `seed` rotates the variant (see leadInForIssue).
 */
export function withLeadIn(
  question: string,
  issueType: IssueType | null | undefined,
  urgency: Urgency | null | undefined,
  index: number,
  seed = 0,
): string {
  const lead = leadInForIssue(issueType, urgency, index, seed);
  return lead ? `${lead} ${question}` : question;
}

export { GENERIC_LEAD_INS, pickVariant };
