// Deterministic, regex-based slot extractor for HVAC intake.
// Pure functions, no I/O, no LLM. Pulls structured contact/location
// slots (address, phone, email) out of a customer's free-text message
// so the chat backend can fill form fields without an LLM call.
//
// Fields mirror the optional/required slots in extraction-schema.ts.
// Name is intentionally skipped — it's too ambiguous for regex.

export interface ExtractedSlots {
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

// Common street suffixes (long + abbreviated). Used to anchor the
// address heuristic so we only match number + name + suffix patterns.
const STREET_SUFFIXES = [
  'street',
  'st',
  'avenue',
  'ave',
  'road',
  'rd',
  'boulevard',
  'blvd',
  'lane',
  'ln',
  'drive',
  'dr',
  'court',
  'ct',
  'way',
  'terrace',
  'place',
  'pl',
  'circle',
  'cir',
  'highway',
  'hwy',
] as const;

const SUFFIX_ALTERNATION = STREET_SUFFIXES.join('|');

// Phone: optional +1 country code, then 10 digits in common groupings.
// (555) 123-4567 / 555-123-4567 / 555.123.4567 / 555 123 4567 / 5551234567
// Word boundaries plus a digit-count guard prevent matching zips or
// reference numbers like REF-12345.
const PHONE_PATTERN =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

// Standard email: local-part@domain.tld. Conservative but covers
// the overwhelming majority of real-world addresses.
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Address: leading street number, street name (1-4 words), a known
// suffix, then an optional unit and an optional ", City, ST 12345" tail.
// `i` for case-insensitivity; anchored on the suffix to stay conservative.
const ADDRESS_PATTERN = new RegExp(
  // street number
  '\\b\\d{1,6}\\s+' +
    // street name: 1-4 capitalized-or-plain words before the suffix
    '(?:[A-Za-z0-9.\'-]+\\s+){0,4}' +
    // suffix (must be a whole word)
    '(?:' +
    SUFFIX_ALTERNATION +
    ')\\b\\.?' +
    // optional unit (Apt 2, Suite 100, #4, Unit B)
    '(?:\\s*,?\\s*(?:apt|apartment|suite|ste|unit|#)\\.?\\s*[A-Za-z0-9-]+)?' +
    // optional ", City, ST 12345" tail
    '(?:\\s*,\\s*[A-Za-z.\'-]+(?:\\s+[A-Za-z.\'-]+)*' +
    '(?:\\s*,?\\s*[A-Za-z]{2})?' +
    '(?:\\s+\\d{5}(?:-\\d{4})?)?)?',
  'i',
);

// Count digits in a candidate to reject things that only look phone-ish.
function digitCount(value: string): number {
  const matches = value.match(/\d/g);
  return matches === null ? 0 : matches.length;
}

export function extractPhone(message: string): string | null {
  const match = message.match(PHONE_PATTERN);
  if (match === null) return null;

  const candidate = match[0].trim();

  // Require exactly 10 significant digits (11 when a leading country
  // code is present). This rejects 5-digit zips and short ref numbers.
  const digits = digitCount(candidate);
  if (digits !== 10 && digits !== 11) return null;

  return candidate;
}

export function extractEmail(message: string): string | null {
  const match = message.match(EMAIL_PATTERN);
  if (match === null) return null;
  return match[0].trim();
}

export function extractAddress(message: string): string | null {
  const match = message.match(ADDRESS_PATTERN);
  if (match === null) return null;

  // Trim surrounding whitespace and any trailing punctuation that is not
  // part of the address itself (e.g. a sentence-ending period or comma).
  const cleaned = match[0].trim().replace(/[\s,.;]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

// Words that look like "number + word" but are NOT addresses — durations,
// quantities, ages. Used to reject false positives in the loose matcher.
const NON_ADDRESS_WORDS = new Set([
  'year', 'years', 'yr', 'yrs',
  'day', 'days', 'week', 'weeks', 'month', 'months',
  'hour', 'hours', 'minute', 'minutes', 'min', 'mins',
  'degree', 'degrees', 'percent', 'dollar', 'dollars',
  'unit', 'units', 'zone', 'zones', 'ton', 'tons',
  'am', 'pm', 'oclock',
]);

// Loose address: a street number followed by at least one capitalized-ish word
// that ISN'T a duration/quantity word. Anchored on a number to avoid matching
// arbitrary phrases. Conservative enough to reject "10 years" / "about 5".
const LOOSE_ADDRESS_PATTERN =
  /\b\d{1,6}\s+([A-Za-z][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9.'-]+){0,4})/;

/**
 * Address extraction used when we have JUST asked the customer for their
 * address (the conversational context says "this is the address"). Tries the
 * strict suffix-anchored pattern first; if that misses, accepts a number +
 * street-name even without a recognized suffix ("123 Main"), while rejecting
 * number-led durations/quantities ("10 years", "5 units"). This fixes the
 * re-ask bug where a suffix-less address fell through to the LLM and got
 * re-asked.
 */
export function extractAddressLoose(message: string): string | null {
  const strict = extractAddress(message);
  if (strict) return strict;

  const match = message.match(LOOSE_ADDRESS_PATTERN);
  if (match === null) return null;

  const firstWord = match[1].split(/\s+/)[0]?.toLowerCase().replace(/[.,]/g, '');
  if (firstWord && NON_ADDRESS_WORDS.has(firstWord)) return null;

  const cleaned = match[0].trim().replace(/[\s,.;]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

// Short answers that are NOT an address when they are the WHOLE reply (or its
// start): "skip" / "human" / "not sure". Matched by equality or prefix so a
// real address ("Stop Street") isn't caught by a bare-word coincidence.
const NON_ADDRESS_EXACT = [
  'skip',
  'human',
  'agent',
  "don't know",
  'dont know',
  'not sure',
  'no idea',
  'cancel',
  'nevermind',
  'never mind',
  'stop',
  'pass',
  'n/a',
];

// Redirect phrases that mark the reply as a request to be contacted rather than
// a service address, even when buried in a sentence ("can someone call me
// instead?"). Matched by substring containment.
const NON_ADDRESS_CONTAINS = [
  'call me',
  'text me',
  'someone call',
  'talk to a human',
  'speak to a human',
  'speak to someone',
  'call instead',
];

/**
 * Address capture for the moment we have JUST asked for the service address
 * (the conversational context guarantees the reply IS the address). This is the
 * most permissive matcher and exists to fix the re-ask bug where a perfectly
 * valid address that doesn't start with a US house number — e.g. an
 * autocomplete pick like "Route Nationale # 3, Commune Pignon, Nord" or
 * "Rockaway Freeway, New York, New York 11693" — fell through every stricter
 * extractor and the bot re-asked for the address.
 *
 * Order matters. At this step the WHOLE reply is the address, so when the
 * cleaned message already looks like an address (has a comma, a 5-digit ZIP, or
 * 3+ words) we return it verbatim — we deliberately do NOT route it through the
 * suffix-anchored extractor, which is built to pull an address out of a longer
 * sentence and would truncate a full state name (e.g. "…, Massachusetts 01104"
 * → "…, Ma"). Only for a short reply with no address signal (e.g. "123 Main")
 * do we fall back to the loose extractor. Refusals/redirects ("skip", "call me
 * instead") and empty replies return null so the caller can defer.
 */
export function extractAddressAtAddressStep(message: string): string | null {
  const cleaned = message.trim().replace(/[\s,.;]+$/, '');
  if (cleaned.length === 0) return null;

  const lower = cleaned.toLowerCase();
  // Reject refusals/redirects so we don't store "skip" or "can someone call me
  // instead?" as the service address.
  if (NON_ADDRESS_EXACT.some((p) => lower === p || lower.startsWith(p + ' '))) {
    return null;
  }
  if (NON_ADDRESS_CONTAINS.some((p) => lower.includes(p))) {
    return null;
  }

  const hasComma = cleaned.includes(',');
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(cleaned);
  const wordCount = cleaned.split(/\s+/).length;
  if (hasComma || hasZip || wordCount >= 3) {
    return cleaned;
  }

  // Short reply, no address signal — try the loose extractor for a number-led
  // street like "123 Main" (rejects "10 years" etc.). Otherwise defer.
  return extractAddressLoose(cleaned);
}

export function extractSlots(message: string): ExtractedSlots {
  return {
    address: extractAddress(message),
    phone: extractPhone(message),
    email: extractEmail(message),
  };
}
