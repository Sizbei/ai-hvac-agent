/**
 * Conversation-style continuity helpers (CHATBOT-PLAN Steps 2, 3, 5).
 *
 * Pure, deterministic, no I/O. These functions decide how the bot should adjust
 * its TONE and PHRASING based on what has already happened in the conversation,
 * so the experience stays coherent across the deterministic↔LLM seam and doesn't
 * loop or ignore a frustrated customer.
 *
 * The route persists the small amount of state these need (an empathy flag, a
 * per-slot re-ask counter, a frustration score) in the session `extras` bag, the
 * same place after-hours/address attempt counters already live.
 */

// ── Step 2: carry tone/voice state across the deterministic↔LLM seam ──────────

/** Stable, non-negative hash of a session id — used to rotate lead-in variants
 * (so consecutive chats don't open identically) without any per-request state.
 * Small, fast FNV-1a-ish fold; collisions are fine (we only mod by a tiny list). */
export function sessionSeed(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Force non-negative.
  return h >>> 0;
}

/**
 * Build the "style so far" hint appended to the LLM system prompt so a fallback
 * turn doesn't restart the "Got it / Understood" empathy decay that the
 * deterministic path already spent its one acknowledgement on.
 *
 * `empathyAlreadyGiven` is true once the deterministic path has emitted its
 * one-time issue acknowledgement (persisted in extras). When true we instruct
 * the model NOT to re-acknowledge the issue — just continue helping plainly.
 */
export function buildStyleHint(opts: {
  empathyAlreadyGiven: boolean;
  turnCount: number;
}): string {
  const lines: string[] = [];
  if (opts.empathyAlreadyGiven) {
    lines.push(
      "The customer's issue has ALREADY been acknowledged earlier in this conversation. Do NOT open with a fresh sympathy line (no \"Got it\", \"Understood\", \"I'm sorry to hear that\", \"That sounds...\"). Continue helping plainly and warmly, as one continuous person.",
    );
  }
  if (opts.turnCount >= 3) {
    lines.push(
      "You are several turns into this conversation — keep replies tight and avoid re-introducing yourself or re-summarizing what's already been said.",
    );
  }
  if (lines.length === 0) return "";
  return `\n\nCONVERSATION STYLE SO FAR: ${lines.join(" ")}`;
}

// ── Step 3: generic re-ask-loop circuit breaker ───────────────────────────────

/** After this many CONSECUTIVE identical slot-questions, switch phrasing and
 * proactively offer "skip" / "talk to a human". Two gives an honest retry first. */
export const REASK_BREAK_THRESHOLD = 2;

/**
 * Update the consecutive-re-ask counter for the slot we are ABOUT to ask.
 *
 * `prevStepId` / `prevCount` are read from extras (the step we asked last turn
 * and how many times in a row we've asked it). `nextStepId` is the step we're
 * about to ask THIS turn. When it's the same step as last turn the count climbs;
 * when it's a different step (progress) the count resets to 1.
 *
 * Returns the new {stepId, count} to persist plus `shouldBreak` — true once the
 * same question has been asked >= REASK_BREAK_THRESHOLD times in a row, so the
 * caller can switch to break-phrasing for this turn.
 */
export function updateReAskState(opts: {
  prevStepId: string | null | undefined;
  prevCount: number | null | undefined;
  nextStepId: string | null;
}): { stepId: string | null; count: number; shouldBreak: boolean } {
  const { prevStepId, nextStepId } = opts;
  if (!nextStepId) {
    // Not asking a slot question this turn (confirm / answer) — clear the loop.
    return { stepId: null, count: 0, shouldBreak: false };
  }
  const prev = Number(opts.prevCount ?? 0);
  const count = prevStepId === nextStepId && prev > 0 ? prev + 1 : 1;
  return {
    stepId: nextStepId,
    count,
    // We've now asked this same question `count` times; break once that reaches
    // the threshold (i.e. the customer has not progressed it after retries).
    shouldBreak: count >= REASK_BREAK_THRESHOLD,
  };
}

/** Per-slot human-readable label for the break copy (what we keep needing). */
const SLOT_LABEL: Record<string, string> = {
  address: "service address",
  address_parts: "service address",
  phone: "phone number",
  name: "name",
  email: "email address",
  system_down: "whether the system is fully down",
  duration: "how long it's been happening",
  urgency: "how urgent it is",
};

/**
 * Re-phrased ask used once the circuit breaker trips: acknowledges the loop,
 * rephrases what we need, and surfaces the skip / human escapes so the customer
 * is never trapped repeating themselves. Generalizes the old address/email-only
 * caps to ANY slot. Returns null when there's no special label (caller keeps the
 * normal question).
 */
export function reAskBreakPrompt(stepId: string): string | null {
  const label = SLOT_LABEL[stepId];
  if (!label) return null;
  return (
    `Sorry — I don't think I've got your ${label} right yet. ` +
    `Could you share it once more? If it's easier, just say "skip" to move on, ` +
    `or "talk to a human" and I'll connect you with our team.`
  );
}

// ── Step 5: frustration-aware human offer ─────────────────────────────────────

// Lowercased frustration signals. Kept conservative — these are unambiguous
// dissatisfaction cues, not mere negatives ("no", "not working" are normal
// intake). Multi-word phrases score the same as single tokens; the running
// score accumulates ACROSS turns so rising frustration is caught early.
const FRUSTRATION_SIGNALS: readonly string[] = [
  "frustrated",
  "frustrating",
  "ridiculous",
  "unacceptable",
  "useless",
  "terrible",
  "awful",
  "worst",
  "annoying",
  "annoyed",
  "fed up",
  "sick of this",
  "waste of time",
  "this is stupid",
  "not helpful",
  "no help",
  "you're not listening",
  "youre not listening",
  "not listening",
  "i already told you",
  "already told you",
  "stop asking",
  "asked already",
  "for the last time",
  "are you even",
  "this isn't working",
  "this isnt working",
  "going in circles",
];

/** Count frustration signals present in a single message (0 when none). */
export function frustrationScore(message: string): number {
  const text = message.toLowerCase();
  let score = 0;
  for (const signal of FRUSTRATION_SIGNALS) {
    if (text.includes(signal)) score += 1;
  }
  return score;
}

/** Cumulative frustration at/above this triggers a proactive human offer
 * BEFORE the turn-limit fallback. Reached by either one strongly-frustrated
 * message (2+ signals) or frustration recurring across turns (1 + 1). */
export const FRUSTRATION_OFFER_THRESHOLD = 2;

/**
 * Fold this turn's frustration into the running total and decide whether to
 * proactively offer a human. `priorScore` is the accumulated score from extras.
 *
 * `offer` fires when the cumulative score crosses the threshold AND we haven't
 * already offered (`alreadyOffered`) — so we surface the human option once,
 * proactively, rather than waiting for the turn-limit fallback or re-offering
 * every turn.
 */
export function updateFrustration(opts: {
  message: string;
  priorScore: number | null | undefined;
  alreadyOffered: boolean;
}): { total: number; offer: boolean } {
  const prior = Math.max(0, Number(opts.priorScore ?? 0));
  const total = prior + frustrationScore(opts.message);
  const offer = !opts.alreadyOffered && total >= FRUSTRATION_OFFER_THRESHOLD;
  return { total, offer };
}

/** Warm, proactive human-handoff offer for a frustrated customer. Kept calm and
 * non-defensive — acknowledges the friction and hands control to the customer. */
export const FRUSTRATION_HUMAN_OFFER =
  "I'm sorry this has been frustrating. Would you like me to connect you with a member of our team? Just say \"talk to a human\" and I'll hand you over — otherwise I'm happy to keep helping.";
