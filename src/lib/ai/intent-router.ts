import { KNOWLEDGE_BASE } from "./knowledge-base";
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
  maintenance: 3,
  scheduling: 3,
  faq: 3,
  meta: 4,
};

// Actions whose canned answer is low-harm if slightly wrong → allowed at the
// lower confidence band.
const LOW_HARM_ACTIONS: ReadonlySet<RouterAction> = new Set<RouterAction>([
  "ANSWER",
  "REDIRECT",
]);

const REQUIRED_SLOTS = ["issueType", "urgency", "address"] as const;

// Alias map applied during normalization AFTER punctuation has been stripped to
// spaces (plan §4 step 1). So "a/c" and "a.c." arrive here as "a c".
const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\ba c\b/g, "air conditioner"],
  [/\bac\b/g, "air conditioner"],
  [/\btstat\b/g, "thermostat"],
  [/\bthermo\b/g, "thermostat"],
  [/\btemp\b/g, "temperature"],
  [/\bco2\b/g, "carbon monoxide"],
  [/\bco\b/g, "carbon monoxide"],
];

/** Lowercase, collapse whitespace, strip punctuation (keep # + digits), alias. */
export function normalize(message: string): string {
  let text = message.toLowerCase();
  // Keep word chars, whitespace, '#', '+'. Replace others with a space.
  text = text.replace(/[^a-z0-9#+\s]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of ALIASES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}

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

function buildReply(
  entry: KnowledgeBaseEntry,
  action: RouterAction,
  known: KnownSlots,
): string {
  if (action !== "SUBMIT") return entry.cannedResponse;
  // All required slots present → confirm rather than ask again.
  return "Great — I have everything I need. Please review the summary and tap Confirm & Submit, and we'll get a technician scheduled.";
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
    return FALLBACK;
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

  if (action === "FALLBACK_LLM") return { ...FALLBACK, confidence };

  if (confidence < LOW_HARM_THRESHOLD) return { ...FALLBACK, confidence };
  if (confidence < ACT_THRESHOLD && !LOW_HARM_ACTIONS.has(action)) {
    return { ...FALLBACK, confidence };
  }

  // 5) COLLECT_INFO → SUBMIT promotion when required slots are complete.
  if (action === "COLLECT_INFO" && missingRequiredSlots(entry, known).length === 0) {
    action = "SUBMIT";
  }

  return {
    action,
    intentId: entry.id,
    confidence,
    reply: buildReply(entry, action, known),
    issueType: entry.issueTypeMapping,
    urgency: entry.urgencyHint,
    escalate: action === "ESCALATE",
  };
}
