/**
 * Deterministic capture of the customer's NAME and of explicit CORRECTIONS to
 * already-captured contact info — both 0-token, no LLM.
 *
 * Two problems this solves:
 *
 *  1. Name capture. The slot extractor (slot-extract.ts) deliberately doesn't
 *     guess names from free text. So when the intake stepper asks "what's your
 *     full name?" and the customer answers "Brian Hoang", nothing deterministic
 *     captures it — it falls through to the slow async LLM extraction. When we
 *     KNOW we just asked the name (pendingStepId === "name"), the whole answer
 *     IS the name; capture it directly.
 *
 *  2. Corrections. Once a slot is filled, the intake stepper stops asking about
 *     it, so a later "actually my name is Brian Hwang" / "change my number to
 *     865-555-1212" / "the address is wrong, it's 5 Oak St, Bristol TN 37620"
 *     has no path to update it through the normal stepper. We detect an explicit
 *     correction phrase and pull the corrected value out, so the caller can pass
 *     it to mergeSlots as a NON-EMPTY update (which overwrites — the merge only
 *     refuses to clobber a filled slot with an EMPTY value).
 *
 * Address/phone/email values are extracted with the same regexes the rest of
 * the intake uses (slot-extract.ts), so a corrected phone/address is validated
 * identically. Names can't be regex-validated, so name corrections require an
 * explicit cue and a plausible 1–4 word value.
 */
import { extractPhone, extractAddressLoose, extractEmail } from "./slot-extract";

export type CorrectionField = "name" | "phone" | "address" | "email";

export interface DetectedCorrection {
  readonly field: CorrectionField;
  readonly value: string;
}

/** Customer-facing label for a corrected field (used in the acknowledgement). */
export function correctionFieldLabel(field: CorrectionField): string {
  switch (field) {
    case "name":
      return "name";
    case "phone":
      return "phone number";
    case "address":
      return "address";
    case "email":
      return "email";
  }
}

// Cue phrases that signal the customer is correcting/restating a value. Matched
// against the lowercased message. Multi-word phrases are plain substrings;
// single ambiguous words ("change"/"update"/"fix"/"use") are word-boundary
// anchored so normal sentences ("someone to fix it", "I use my AC daily",
// "update me when you arrive") don't read as corrections.
const CORRECTION_CUE_PHRASES = [
  "actually",
  "no wait",
  "i meant",
  "i mean",
  "correction",
  "that's wrong",
  "thats wrong",
  "it should be",
  "it's actually",
  "its actually",
  "make it",
  "instead",
];
const CORRECTION_CUE_WORDS = ["wait", "change", "update", "fix", "use"];
const CUE_WORD_PATTERN = new RegExp(
  `\\b(?:${CORRECTION_CUE_WORDS.join("|")})\\b`,
);

/** True when the message carries an explicit "I want to change something" cue. */
export function hasCorrectionCue(message: string): boolean {
  const m = message.toLowerCase();
  if (CORRECTION_CUE_PHRASES.some((cue) => m.includes(cue))) return true;
  return CUE_WORD_PATTERN.test(m);
}

// Which field a correction targets, by keyword. Order matters only for logging;
// a message naming two fields is rare and we take the first concrete value we
// can extract below.
// NOTE: name targeting is deliberately NARROW — only explicit "name"/"call me".
// Pronoun fragments ("i'm", "i am") are NOT name keywords: they appear in
// countless non-name sentences ("actually i'm worried about the cost"), and
// treating them as a name-correction target corrupted the stored name. The cue
// anchors in extractNameFromCue still handle "my name is X" / "i'm X" when the
// message is actually a name, but only via the explicit "name" field route below.
const FIELD_KEYWORDS: ReadonlyArray<readonly [CorrectionField, readonly string[]]> = [
  ["phone", ["number", "phone", "cell", "mobile", "call me at", "reach me at"]],
  ["address", ["address", "street", "location", "where i live", "come to"]],
  ["email", ["email", "e-mail", "mail"]],
  ["name", ["name", "call me"]],
];

/** Cap a free-text name so a rambling sentence can't become the "name". */
const MAX_NAME_WORDS = 4;
const MAX_NAME_CHARS = 60;

/**
 * Pull a plausible person-name out of a message given an explicit name cue.
 * Anchors on a cue ("my name is", "i'm", "call me", "name to/is") and takes the
 * 1–4 capitalized-ish words after it. Returns null if nothing plausible.
 */
export function extractNameFromCue(message: string): string | null {
  // Match a cue, then capture the following words (letters, spaces, hyphens,
  // apostrophes, periods). Case-insensitive; we re-case downstream via
  // sanitizeName, so we accept any input casing here.
  const cuePattern =
    /(?:my name(?:'s| is)?|name(?:'s| is)?(?:\s+(?:to|now))?|call me|i am|i'm|im)\s+(?:is\s+|to\s+|now\s+)?([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})/i;
  const match = message.match(cuePattern);
  if (!match) return null;

  let candidate = match[1].trim();
  if (candidate.length === 0 || candidate.length > MAX_NAME_CHARS) return null;

  // Drop trailing filler that sometimes trails a name ("Brian thanks", "Brian
  // please"). Conservative stop-word list of common non-name trailing tokens.
  const STOP = new Set([
    "thanks", "please", "thank", "now", "ok", "okay", "and", "the", "is",
    "actually", "instead", "today", "tomorrow",
  ]);
  const words = candidate.split(/\s+/).filter((w) => w.length > 0);
  const kept: string[] = [];
  for (const w of words) {
    if (STOP.has(w.toLowerCase())) break;
    kept.push(w);
    if (kept.length >= MAX_NAME_WORDS) break;
  }
  if (kept.length === 0) return null;
  candidate = kept.join(" ");

  return candidate.length > 0 ? candidate : null;
}

/**
 * The whole message, treated as a name (used when we KNOW we just asked the
 * name). Strips a leading polite preamble ("it's", "my name is", "this is")
 * and caps length/word-count. Returns null if it doesn't look like a name
 * (empty, too long, contains digits — a phone/address typed at the name prompt
 * is handled by the normal extractors instead).
 */
export function nameFromDirectAnswer(message: string): string | null {
  let m = message
    .trim()
    .replace(/^(?:it'?s|this is|my name(?:'s| is)?|i'?m|i am)\s+/i, "")
    .replace(/[.!,]+$/, "")
    .trim();

  if (m.length === 0 || m.length > MAX_NAME_CHARS) return null;
  // A name shouldn't contain digits; if it does the customer likely typed a
  // phone/address at the prompt — let the dedicated extractors handle it.
  if (/\d/.test(m)) return null;

  const words = m.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return null;
  // Each token must be mostly alphabetic (allow hyphen/apostrophe/period).
  if (!words.every((w) => /^[a-z][a-z.'-]*$/i.test(w))) return null;

  m = words.join(" ");
  return m;
}

/**
 * Detect a deterministic contact-field update from this turn.
 *
 * @param message       the customer's (sanitized) message
 * @param pendingStepId the triage step we just asked (so a name answer is known)
 *
 * Resolution order:
 *  1. If we just asked the NAME step, the message is the name (direct answer).
 *  2. Else, if the message carries a correction cue, figure out which field and
 *     extract the corrected value (phone/address/email via the shared regexes,
 *     name via the cue extractor).
 *
 * Returns null when there's nothing to deterministically apply.
 */
export function detectCorrection(
  message: string,
  pendingStepId: string | null,
): DetectedCorrection | null {
  // 1. Direct answer to the name question.
  if (pendingStepId === "name") {
    const name = nameFromDirectAnswer(message);
    if (name) return { field: "name", value: name };
  }

  if (!hasCorrectionCue(message)) return null;

  // 2. Which field is being corrected? Use the keyword that appears.
  const lower = message.toLowerCase();
  const targeted = FIELD_KEYWORDS.find(([, kws]) =>
    kws.some((kw) => lower.includes(kw)),
  )?.[0];

  // Try the targeted field first, then fall back to whatever concrete value we
  // can extract (a correction like "no, 865-555-1212" names no field).
  const tryPhone = (): DetectedCorrection | null => {
    const p = extractPhone(message);
    return p ? { field: "phone", value: p } : null;
  };
  const tryAddress = (): DetectedCorrection | null => {
    const a = extractAddressLoose(message);
    return a ? { field: "address", value: a } : null;
  };
  const tryEmail = (): DetectedCorrection | null => {
    const e = extractEmail(message);
    return e ? { field: "email", value: e } : null;
  };
  const tryName = (): DetectedCorrection | null => {
    const n = extractNameFromCue(message);
    return n ? { field: "name", value: n } : null;
  };

  if (targeted === "phone") return tryPhone() ?? tryAddress() ?? tryEmail();
  if (targeted === "address") return tryAddress() ?? tryPhone() ?? tryEmail();
  if (targeted === "email") return tryEmail() ?? tryPhone() ?? tryAddress();
  if (targeted === "name") return tryName() ?? tryPhone() ?? tryAddress() ?? tryEmail();

  // No explicit field keyword — accept a bare corrected value (phone/email/
  // address only; a bare name with no cue is too ambiguous).
  return tryPhone() ?? tryEmail() ?? tryAddress();
}
