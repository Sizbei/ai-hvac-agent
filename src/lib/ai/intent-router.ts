import { KNOWLEDGE_BASE } from "./knowledge-base";
import { CONFIRM_REPLY } from "./constants";
import { normalize } from "./text-normalize";
import {
  EMPTY_ORG_CONFIG,
  disabledIntentIds,
  declineReply,
  matchCustomFaq,
  personalizeAnswer,
  type RouterOrgConfig,
} from "./router-config";
import type {
  KnowledgeBaseEntry,
  RouterAction,
  IssueType,
  Urgency,
} from "./router-types";

/**
 * Deterministic intent router.
 *
 * Given a (sanitized) customer message and the slots already known for the
 * session, returns a verdict telling the chat handler whether it can answer/act
 * WITHOUT an LLM call, or must fall back to the LLM. Pure function, no I/O.
 *
 * Design (see docs/COMMON-QUESTIONS-PLAN.md):
 *  - Normalize → score → priority/confidence → verdict.
 *  - EMERGENCY short-circuits everything (low threshold, requires a qualifier).
 *  - Compound / low-confidence / non-Latin input → FALLBACK_LLM.
 *  - COLLECT_INFO never re-asks an already-filled slot; when all required slots
 *    are present the action becomes SUBMIT.
 */

export interface KnownSlots {
  readonly issueType?: IssueType | null;
  readonly urgency?: Urgency | null;
  readonly address?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  // ServiceTitan-style enrichment fields carried as a generic bag (see
  // chat-slots.ts EXTRA_SLOT_KEYS). Optional; the router itself doesn't read
  // them, but they ride along through merge/parse/build so they persist.
  readonly extras?: Record<string, unknown>;
}

export interface RouterVerdict {
  /** The action to take. FALLBACK_LLM means "let the LLM handle it". */
  readonly action: RouterAction;
  readonly intentId: string | null;
  readonly confidence: number;
  /** Canned text to send the customer; null when action is FALLBACK_LLM. */
  readonly reply: string | null;
  /** Deterministic slot values to merge into session metadata. */
  readonly issueType: IssueType | null;
  readonly urgency: Urgency | null;
  /** True when this verdict should escalate the session to a human. */
  readonly escalate: boolean;
}

const FALLBACK: RouterVerdict = {
  action: "FALLBACK_LLM",
  intentId: null,
  confidence: 0,
  reply: null,
  issueType: null,
  urgency: null,
  escalate: false,
};

// Confidence thresholds (plan §4 / review H4).
const ACT_THRESHOLD = 0.7;
const LOW_HARM_THRESHOLD = 0.45;
const EMERGENCY_THRESHOLD = 0.25;
// Smoothing constant in the confidence denominator. Tuned so a single-token
// low-harm match (e.g. a bare "hi" greeting, score 1) clears LOW_HARM_THRESHOLD
// while a single token still stays below ACT_THRESHOLD for higher-harm actions.
const SMOOTHING = 0.75;

// Category priority — lower number wins ties (plan §4). meta is lowest so a
// greeting never shadows a real issue mentioned in the same message.
const CATEGORY_PRIORITY: Record<string, number> = {
  emergency: 0,
  account: 1,
  cooling: 2,
  heating: 2,
  airquality: 2,
  thermostat: 2,
  equipment: 2,
  refrigerant: 2,
  // Spears commercial service lines: walk-in coolers, ice machines, etc. Same
  // priority as the other equipment-symptom categories so a refrigeration
  // symptom wins a tie against a priority-3 FAQ.
  refrigeration: 2,
  maintenance: 3,
  scheduling: 3,
  faq: 3,
  pricing: 3,
  membership: 3,
  efficiency: 3,
  replacement: 3,
  service_logistics: 3,
  trust: 3,
  warranty: 3,
  // Identified-customer account-data reads (membership/visit/balance/appointment/
  // reschedule). LOWEST tier (== meta) so an account question can NEVER outrank
  // an emergency, a real issue, or booking. The chat route enforces the identity
  // gate before acting on an ACCOUNT_LOOKUP verdict.
  account_data: 4,
  meta: 4,
};

// Actions whose canned answer is low-harm if slightly wrong → allowed at the
// lower confidence band.
const LOW_HARM_ACTIONS: ReadonlySet<RouterAction> = new Set<RouterAction>([
  "ANSWER",
  "REDIRECT",
]);

const REQUIRED_SLOTS = ["issueType", "urgency", "address"] as const;

// Legacy account/scheduling REFERENCE intents the catalog encodes as
// FALLBACK_LLM punts, now backed by real identified-customer read-tools (see
// src/lib/ai/account-tools.ts + the chat route's ACCOUNT_LOOKUP dispatch). When
// one of these wins, the router emits an ACCOUNT_LOOKUP verdict so the route can
// dispatch it for an identified customer; the route enforces the identity gate.
// scheduling-cancel is NOT here — cancel is out of the safe v1 capability set.
const LEGACY_ACCOUNT_REFERENCE_INTENTS: ReadonlySet<string> = new Set([
  "account-check-status",
  "account-change-appointment",
  "scheduling-reschedule",
]);

// The canned identify ask carried on a legacy-intent ACCOUNT_LOOKUP verdict — the
// chat route surfaces it verbatim for an UNIDENTIFIED session (so we ask for the
// account contact, never leak data). Mirrors the new account_data entries' copy.
const LEGACY_ACCOUNT_IDENTIFY_ASK =
  "I can help with that. What's the email or phone number on your account?";

// Re-export so existing importers (and tests) keep
// `import { normalize } from "./intent-router"` working.
export { normalize };

/** Ratio of latin-alphabetic characters to total non-space characters. */
function latinAlphaRatio(message: string): number {
  const compact = message.replace(/\s/g, "");
  if (compact.length === 0) return 0;
  const latin = compact.replace(/[^a-zA-Z]/g, "").length;
  return latin / compact.length;
}

function phraseWeight(keyword: string): number {
  return keyword.includes(" ") ? 3 : 1;
}

function includesPhrase(haystack: string, needle: string): boolean {
  // Word-ish boundary for single tokens; substring for multi-word phrases.
  if (needle.includes(" ")) return haystack.includes(needle);
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Scored {
  readonly entry: KnowledgeBaseEntry;
  readonly score: number;
}

/** Score one entry against the normalized message, honoring guards/qualifiers. */
function scoreEntry(entry: KnowledgeBaseEntry, text: string): number {
  // Negation guards suppress the entry entirely.
  if (entry.negationGuards?.some((g) => includesPhrase(text, normalize(g)))) {
    return 0;
  }
  // Emergency entries require a co-occurring qualifier (review H4).
  if (
    entry.requiredQualifiers &&
    entry.requiredQualifiers.length > 0 &&
    !entry.requiredQualifiers.some((q) => includesPhrase(text, normalize(q)))
  ) {
    return 0;
  }
  let score = 0;
  for (const keyword of entry.triggerKeywords) {
    const normalizedKeyword = normalize(keyword);
    if (normalizedKeyword && includesPhrase(text, normalizedKeyword)) {
      score += phraseWeight(normalizedKeyword);
    }
  }
  return score;
}

function isGibberish(text: string): boolean {
  if (text.length === 0) return true;
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  // A real sentence isn't gibberish by this heuristic.
  if (tokens.length > 3) return false;
  // Every token must look like keyboard-mash: too few vowels for its length, or
  // an implausibly long consonant run (e.g. "asdfghjkl", "lkjsdf", "qwerty").
  return tokens.every((t) => {
    if (t.length < 4) return false;
    // Pure-digit tokens (zip codes, phone fragments) are real input, not mash.
    if (/^\d+$/.test(t)) return false;
    const vowels = (t.match(/[aeiou]/g) ?? []).length;
    const vowelRatio = vowels / t.length;
    const consonantRuns = t.match(/[^aeiou]+/g) ?? [];
    const maxConsonantRun = consonantRuns.reduce(
      (max, run) => Math.max(max, run.length),
      0,
    );
    return vowelRatio < 0.25 || maxConsonantRun >= 5;
  });
}

// ── Deterministic ambiguity probes (CHATBOT-PLAN Step 16) ──
//
// When a message is genuinely ambiguous between a few common categories — and we
// would otherwise punt to the LLM — return a crisp clarifying question instead.
// CONSERVATIVE BY DESIGN: only a handful of clear, high-frequency ambiguities get
// a probe; everything else still falls back to the LLM. A probe is the LOWEST-
// precedence deterministic verdict: it is only ever reached AFTER the emergency
// short-circuit, the custom-FAQ check, and the compound-message detector have run
// (so it can never outrank a hazard, a compound multi-intent punt, or a confident
// known intent). It NEVER captures a slot or commits to anything — it just asks.

/** A single probe: when `applies` is true for the (text, slots), ask `question`. */
interface AmbiguityProbe {
  readonly id: string;
  readonly question: string;
  readonly applies: (text: string, known: KnownSlots) => boolean;
}

// Vague "it doesn't work" with no symptom direction → which way is it failing?
// Only fires when the customer hasn't already told us the issue type (so we don't
// re-ask a known direction) and the message carries NO cooling/heating/noise cue.
// NB: normalize() turns an apostrophe into a SPACE ("isn't" → "isn t"), so each
// contraction is listed with the apostrophe removed AND with the space variant
// where it changes word adjacency (e.g. "isn t working").
const VAGUE_MALFUNCTION_TERMS = [
  "not working",
  "isnt working",
  "isn t working",
  "stopped working",
  "doesnt work",
  "doesn t work",
  "dont work",
  "don t work",
  "broken",
  "broke",
  "not turning on",
  "wont turn on",
  "won t turn on",
  "acting up",
  "having issues",
  "having problems",
];
const DIRECTION_CUES = [
  "cool",
  "cold",
  "ac",
  "air condition",
  "heat",
  "warm",
  "furnace",
  "noise",
  "noisy",
  "sound",
  "rattl",
  "bang",
  "squeal",
  "grind",
  "leak",
  "water",
  "smell",
];

// "Cooler" / "unit" that could be a home AC or a commercial walk-in cooler, with
// no home/commercial signal yet → which is it? Only the refrigeration-vs-residential
// ambiguity; a plain "ac"/"furnace" is unambiguous and not probed.
const HOME_OR_COMMERCIAL_TERMS = ["cooler", "walk in", "walk-in", "freezer"];
const PROPERTY_CUES = [
  "home",
  "house",
  "residential",
  "apartment",
  "condo",
  "commercial",
  "business",
  "restaurant",
  "office",
  "store",
  "shop",
];

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((t) => text.includes(t));
}

const AMBIGUITY_PROBES: readonly AmbiguityProbe[] = [
  {
    id: "clarify-malfunction-direction",
    question:
      "Happy to help — is it not cooling, not heating, or making a noise?",
    applies: (text, known) =>
      !known.issueType &&
      hasAny(text, VAGUE_MALFUNCTION_TERMS) &&
      !hasAny(text, DIRECTION_CUES),
  },
  {
    id: "clarify-home-or-commercial",
    question: "Got it — is this for your home or a commercial property?",
    applies: (text, known) =>
      !known.extras?.propertyType &&
      hasAny(text, HOME_OR_COMMERCIAL_TERMS) &&
      !hasAny(text, PROPERTY_CUES),
  },
];

/**
 * The deterministic ambiguity probe for a message, or null when none applies.
 * Pure; reads only the normalized text + already-known slots. The first matching
 * probe wins (ordered most-common-first). Returns a CLARIFY verdict carrying the
 * question as `reply` — the route serves it as a canned reply (0 LLM tokens).
 */
function ambiguityProbe(text: string, known: KnownSlots): RouterVerdict | null {
  for (const probe of AMBIGUITY_PROBES) {
    if (probe.applies(text, known)) {
      return {
        action: "CLARIFY",
        intentId: probe.id,
        confidence: 0,
        reply: probe.question,
        issueType: null,
        urgency: null,
        escalate: false,
      };
    }
  }
  return null;
}

function buildReply(
  entry: KnowledgeBaseEntry,
  action: RouterAction,
  _known: KnownSlots,
): string {
  if (action !== "SUBMIT") return entry.cannedResponse;
  // All required slots present → confirm rather than ask again.
  return CONFIRM_REPLY;
}

/** Required slots still missing once this entry's mappings are applied. */
function missingRequiredSlots(
  entry: KnowledgeBaseEntry,
  known: KnownSlots,
): readonly string[] {
  const projected: Record<string, unknown> = {
    issueType: known.issueType ?? entry.issueTypeMapping,
    urgency: known.urgency ?? entry.urgencyHint,
    address: known.address,
  };
  return REQUIRED_SLOTS.filter((slot) => {
    const value = projected[slot];
    return value === null || value === undefined || value === "";
  });
}

export function routeMessage(
  rawMessage: string,
  known: KnownSlots = {},
  config: RouterOrgConfig = EMPTY_ORG_CONFIG,
): RouterVerdict {
  const text = normalize(rawMessage);

  if (text.length === 0) return FALLBACK;

  // Non-Latin / very low alpha-ratio input → let the LLM handle it (review M4),
  // but only when it isn't recognizable gibberish noise.
  if (latinAlphaRatio(rawMessage) < 0.5 && !isGibberish(text)) {
    return FALLBACK;
  }

  // Score every entry.
  const scored: Scored[] = KNOWLEDGE_BASE.map((entry) => ({
    entry,
    score: scoreEntry(entry, text),
  })).filter((s) => s.score > 0);

  // 1) EMERGENCY short-circuit — safety beats everything (plan §4 / review H4).
  // Runs BEFORE any org config so no per-org setting can suppress an escalation.
  const emergencies = scored
    .filter((s) => s.entry.category === "emergency")
    .sort((a, b) => b.score - a.score);
  if (emergencies.length > 0) {
    const top = emergencies[0];
    const confidence = top.score / (top.score + SMOOTHING);
    if (confidence >= EMERGENCY_THRESHOLD) {
      return {
        action: "ESCALATE",
        intentId: top.entry.id,
        confidence,
        reply: top.entry.cannedResponse,
        issueType: top.entry.issueTypeMapping,
        urgency: top.entry.urgencyHint,
        escalate: true,
      };
    }
  }

  // 1b) Custom FAQ — admin-authored answers take precedence over the built-in
  // catalog (but never over an emergency). Matched on the normalized text.
  const customFaq = matchCustomFaq(text, config.customFaqs);
  if (customFaq) {
    return {
      action: "ANSWER",
      intentId: `custom-faq:${customFaq.id}`,
      confidence: 1,
      reply: customFaq.answer,
      issueType: null,
      urgency: null,
      escalate: false,
    };
  }

  const disabled = disabledIntentIds(config);

  if (scored.length === 0) {
    // Nothing matched. Detect pure noise; otherwise fall back.
    if (isGibberish(text)) {
      const gibberish = KNOWLEDGE_BASE.find(
        (e) => e.id === "meta-gibberish-empty",
      );
      if (gibberish) {
        return {
          action: "ANSWER",
          intentId: gibberish.id,
          confidence: 1,
          reply: gibberish.cannedResponse,
          issueType: null,
          urgency: null,
          escalate: false,
        };
      }
    }
    // Nothing matched the catalog (e.g. a bare "it's not working"). Try a
    // deterministic ambiguity probe before punting to the LLM.
    return ambiguityProbe(text, known) ?? FALLBACK;
  }

  // 2) Compound-message detector (review H4): if two or more DISTINCT
  // non-meta categories score meaningfully, defer to the LLM.
  const meaningful = scored.filter((s) => s.score >= 3);
  const distinctCategories = new Set(
    meaningful
      .filter((s) => s.entry.category !== "meta")
      .map((s) => s.entry.category),
  );
  if (distinctCategories.size >= 2) {
    return FALLBACK;
  }

  // 3) Rank by (priority, score). Lower priority number wins; higher score breaks ties.
  const ranked = [...scored].sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.entry.category] ?? 5;
    const pb = CATEGORY_PRIORITY[b.entry.category] ?? 5;
    if (pa !== pb) return pa - pb;
    return b.score - a.score;
  });

  const top = ranked[0];
  const runnerUp = ranked[1];
  const confidence =
    top.score / (top.score + (runnerUp?.score ?? 0) + SMOOTHING);

  // 4) Confidence gate.
  const entry = top.entry;
  let action = entry.action;

  // 4a) Services the org has turned off: if the winning intent is for a service
  // this org doesn't offer, politely decline/redirect instead of answering
  // "yes we do that" — OR letting it fall through to the LLM (which would also
  // happily offer it). This runs BEFORE the FALLBACK_LLM gate so a disabled
  // FALLBACK_LLM intent (e.g. boiler) still declines, but still respects the
  // low-harm confidence floor so a weak spurious match doesn't wrongly decline.
  // Emergencies already returned above, so this can never block a hazard.
  if (disabled.has(entry.id) && confidence >= LOW_HARM_THRESHOLD) {
    return {
      action: "REDIRECT",
      intentId: entry.id,
      confidence,
      reply: declineReply(),
      issueType: null,
      urgency: null,
      escalate: false,
    };
  }

  // Legacy account/scheduling REFERENCE intents that the catalog encodes as
  // FALLBACK_LLM punts (account-check-status, account-change-appointment,
  // scheduling-reschedule) are now backed by real identified-customer read-tools.
  // Surface them as ACCOUNT_LOOKUP (with the intentId + the canned identify ask)
  // so the chat route can dispatch them for an identified customer — WITHOUT
  // changing the general FALLBACK_LLM contract (intentId/reply stay null for
  // every other punt). The route enforces identity; an unidentified session gets
  // the canned identify ask, never another customer's data. This sits ABOVE the
  // FALLBACK/confidence gates because these entries' canned text is the safe,
  // low-harm identify ask (no data is asserted), so a weak match is harmless.
  if (LEGACY_ACCOUNT_REFERENCE_INTENTS.has(entry.id)) {
    return {
      action: "ACCOUNT_LOOKUP",
      intentId: entry.id,
      confidence,
      reply: LEGACY_ACCOUNT_IDENTIFY_ASK,
      issueType: null,
      urgency: null,
      escalate: false,
    };
  }

  // From here a known intent is about to PUNT to the LLM (it's a FALLBACK_LLM
  // intent, or its confidence is below the act threshold). Before punting, try a
  // deterministic ambiguity probe — this sits BELOW the emergency short-circuit,
  // the custom-FAQ check, and the compound detector (all returned above), so a
  // probe can never outrank a hazard, a multi-intent punt, or a confident intent.
  if (action === "FALLBACK_LLM") {
    return ambiguityProbe(text, known) ?? { ...FALLBACK, confidence };
  }

  if (confidence < LOW_HARM_THRESHOLD) {
    return ambiguityProbe(text, known) ?? { ...FALLBACK, confidence };
  }
  if (confidence < ACT_THRESHOLD && !LOW_HARM_ACTIONS.has(action)) {
    return ambiguityProbe(text, known) ?? { ...FALLBACK, confidence };
  }

  // 5) COLLECT_INFO → SUBMIT promotion when required slots are complete.
  if (action === "COLLECT_INFO" && missingRequiredSlots(entry, known).length === 0) {
    action = "SUBMIT";
  }

  // Personalize the canned answer with the org's business info where we have a
  // concrete field for this intent; otherwise the safe generic text stands.
  const baseReply = buildReply(entry, action, known);
  const reply =
    action === "ANSWER"
      ? personalizeAnswer(entry.id, baseReply, config.businessInfo)
      : baseReply;

  return {
    action,
    intentId: entry.id,
    confidence,
    reply,
    issueType: entry.issueTypeMapping,
    urgency: entry.urgencyHint,
    escalate: action === "ESCALATE",
  };
}
