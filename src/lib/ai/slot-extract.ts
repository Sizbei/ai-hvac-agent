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

export function extractSlots(message: string): ExtractedSlots {
  return {
    address: extractAddress(message),
    phone: extractPhone(message),
    email: extractEmail(message),
  };
}
