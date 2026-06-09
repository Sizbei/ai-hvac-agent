/**
 * Multi-field contact extraction — capture EVERY recognizable contact field from
 * a single message, 0-token, no LLM.
 *
 * The intake stepper asks one thing at a time, but customers don't answer that
 * way: "ray chen, 4169029212" is a name AND a phone in one breath; "I'm at 120
 * Broadway, Johnson City TN 37604, reach me at ray@x.com" is an address AND an
 * email. The single-slot extractors (slot-extract.ts) and the name-on-name-step
 * capture (detect-correction.ts) each see only their own field, so a multi-field
 * message dropped everything except the one slot the current step expected,
 * forcing the bot to re-ask for info the customer already gave.
 *
 * This module runs ALL the field extractors over the message and returns
 * whatever it finds. Phone/email/address reuse the shared validated regexes;
 * the name is pulled conservatively from the alphabetic residual (the leading
 * segment before any digit/email/@), validated like a direct name answer so a
 * stray word never becomes a name.
 *
 * Pure, no I/O — unit-tested without a DB.
 */
import { extractAddressLoose, extractPhone, extractEmail } from "./slot-extract";
import { nameFromDirectAnswer } from "./detect-correction";

/** Title-case a captured name ("ray chen" → "Ray Chen"), preserving intra-token
 * punctuation (O'Brien, Anne-Marie). The route also runs sanitizeName, but we
 * normalize here so the module's standalone output is display-ready. */
function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) =>
      w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

export interface AllContactFields {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
}

/**
 * Pull a name from the part of the message that ISN'T the phone/email/address.
 * Conservative: takes the leading run of alphabetic words BEFORE the first digit
 * or "@" (the common "Ray Chen, 416..." / "Ray Chen ray@x.com" shape), strips a
 * trailing separator, and validates it as a real name via nameFromDirectAnswer
 * (which rejects digits, over-long, or non-alphabetic tokens). Returns null when
 * no plausible leading name exists — we never guess a name from arbitrary prose.
 */
function nameFromResidual(message: string, email: string | null): string | null {
  let head = message.trim();

  // Cut at the first email so "Ray Chen ray@x.com" → "Ray Chen".
  if (email) {
    const at = head.toLowerCase().indexOf(email.toLowerCase());
    if (at > 0) head = head.slice(0, at);
  }
  // Cut at the first digit so "Ray Chen, 4169029212" → "Ray Chen, ".
  const firstDigit = head.search(/\d/);
  if (firstDigit >= 0) head = head.slice(0, firstDigit);

  // Drop a trailing separator (comma / dash / "at" / "phone"/"email" label).
  head = head
    .replace(/[,;:\-–—]+\s*$/, "")
    .replace(/\b(?:at|phone|number|email|cell|mobile|call)\b\s*$/i, "")
    .trim();

  if (head.length === 0) return null;
  // nameFromDirectAnswer also strips "it's"/"my name is" preambles and enforces
  // the 1–4 alphabetic-word shape, so we get the same validation as a name-step
  // answer. A leading street word ("120 Broadway") already lost its number above,
  // but the residual "Broadway" is a single word — allowed only if it looks like
  // a name; we accept that risk only when the head has ≥1 word and no address
  // suffix follows. To stay conservative, require ≥2 words OR an explicit name
  // preamble handled inside nameFromDirectAnswer.
  const validated = nameFromDirectAnswer(head);
  if (!validated) return null;
  // Require at least two words for a residual (no cue) name, so a lone word
  // ("Broadway", "Help") is never mistaken for a name. A cue-based name comes
  // through detect-correction.extractNameFromCue instead.
  const wordCount = validated.split(/\s+/).filter((w) => w.length > 0).length;
  return wordCount >= 2 ? titleCaseName(validated) : null;
}

/**
 * Extract every contact field present in the message. Phone/email/address use
 * the shared validated extractors (strict: real 10/11-digit phone, real email,
 * number+street+suffix address). Name is the conservative leading residual.
 *
 * @param message            the customer's (sanitized) message
 * @param opts.allowResidualName  when true, attempt the residual-name heuristic
 *   (use for early/multi-field messages). When false, name is left null and only
 *   a name-step answer / explicit cue (handled elsewhere) fills the name. Default
 *   true.
 */
export function extractAllContactFields(
  message: string,
  opts: { readonly allowResidualName?: boolean } = {},
): AllContactFields {
  const allowResidualName = opts.allowResidualName ?? true;
  const phone = extractPhone(message);
  const email = extractEmail(message);
  // Loose (not strict) address: a multi-field dump often gives the street first
  // ("120 Broadway, ...") and the strict completeness check + the address_parts
  // follow-up fill in city/ZIP. Capturing the street here beats capturing nothing.
  const address = extractAddressLoose(message);
  // A residual name is only trustworthy when the SAME message also carries a
  // concrete contact field (phone/email/address). That co-occurrence is what
  // distinguishes "ray chen, 4169029212" (a name + phone dump) from arbitrary
  // prose like "my ac is broken" (4 alphabetic words that would otherwise pass
  // the name shape check). Without a co-field we leave name to the name step /
  // an explicit cue, never guessing from free text.
  const hasCoField = Boolean(phone || email || address);
  const name =
    allowResidualName && hasCoField ? nameFromResidual(message, email) : null;
  return { name, phone, email, address };
}
