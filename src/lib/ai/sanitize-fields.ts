/**
 * Field-value sanitization for captured customer contact data.
 *
 * The slot extractors and the LLM hand us values exactly as the customer typed
 * them ("brian hoang", "5551234567", "123 main st  ,knoxville tn 37920"). These
 * pure functions normalize the presentation BEFORE we echo a value back in the
 * confirmation recap or persist it, so a dispatcher and the customer both see a
 * clean, consistent record. They are intentionally conservative: they fix
 * casing/spacing/formatting, never invent or drop information.
 *
 * No I/O, no dependencies — trivially unit-tested and reusable by both the chat
 * capture path and the confirm/persist boundary.
 */

/**
 * Title-case a person's name while respecting the casing conventions people
 * actually use: hyphenated names (Anne-Marie), apostrophes (O'Brien), and the
 * Mc/Mac and Scots/Irish particles. Collapses runs of whitespace. Leaves a name
 * the customer clearly typed in deliberate mixed case (e.g. "McDonald") alone
 * only insofar as our rules reproduce it.
 *
 * "brian hoang"  -> "Brian Hoang"
 * "JOHN SMITH"   -> "John Smith"
 * "o'brien"      -> "O'Brien"
 * "anne-marie"   -> "Anne-Marie"
 * "mcdonald"     -> "McDonald"
 */
export function sanitizeName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return collapsed;

  // Capitalize the first alphabetic letter of each token, lowercasing the rest,
  // then apply sub-rules for separators (hyphen, apostrophe) and Mc/Mac.
  const capitalizeWord = (word: string): string => {
    // Split on hyphen so each part of "anne-marie" is capitalized.
    return word
      .split("-")
      .map((part) => capitalizeSegment(part))
      .join("-");
  };

  return collapsed.split(" ").map(capitalizeWord).join(" ");
}

/** Capitalize one hyphen-free segment, handling apostrophes and Mc/Mac. */
function capitalizeSegment(segment: string): string {
  if (segment.length === 0) return segment;

  // Apostrophe parts: O'Brien, D'Angelo — capitalize each side.
  if (segment.includes("'")) {
    return segment
      .split("'")
      .map((p) => simpleCapitalize(p))
      .join("'");
  }

  const lower = segment.toLowerCase();
  // Mc/Mac prefixes: capitalize the prefix AND the following letter.
  if (lower.startsWith("mc") && lower.length > 2) {
    return "Mc" + simpleCapitalize(lower.slice(2));
  }
  if (lower.startsWith("mac") && lower.length > 3) {
    return "Mac" + simpleCapitalize(lower.slice(3));
  }

  return simpleCapitalize(lower);
}

/** Upper-case the first character, leave the (already-lowered) rest. */
function simpleCapitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Normalize a US/NANP phone number for storage/display. Keeps a leading "+1"
 * country code when present, formats 10 digits as (AAA) BBB-CCCC. If the input
 * doesn't have a clean 10/11-digit NANP shape, returns the digit-trimmed input
 * unchanged rather than guessing — we never want to silently mangle an
 * international or extension-bearing number.
 *
 * "5551234567"       -> "(555) 123-4567"
 * "555-123-4567"     -> "(555) 123-4567"
 * "+1 555 123 4567"  -> "+1 (555) 123-4567"
 * "1 (555) 123 4567" -> "+1 (555) 123-4567"
 */
export function sanitizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");

  // 11 digits starting with 1 → NANP with country code.
  if (digits.length === 11 && digits.startsWith("1")) {
    const d = digits.slice(1);
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  // Exactly 10 digits → NANP without country code.
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  // Anything else (extensions, international, partial) — collapse whitespace but
  // don't reformat into a shape it isn't.
  return trimmed.replace(/\s+/g, " ");
}

const STATE_ABBREVIATIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

// Lowercase street/address words that should stay lowercase-cased correctly but
// are commonly all-caps or all-lower in raw input. We title-case generically and
// then fix the two cases that matter: the 2-letter state code (upper) and the
// ZIP (untouched). Directionals and unit markers come out fine from title-case.
/**
 * Tidy a free-text service address: collapse whitespace, normalize the spacing
 * around commas, title-case the words, and upper-case a trailing 2-letter state
 * code and keep the ZIP intact. Conservative — this is for display polish, not
 * USPS canonicalization (the tech still reads the literal text).
 *
 * "123 main st  ,knoxville tn 37920" -> "123 Main St, Knoxville TN 37920"
 */
export function sanitizeAddress(raw: string): string {
  // Normalize comma spacing ("st  ,knoxville" -> "st, knoxville") and collapse
  // whitespace.
  const collapsed = raw
    .trim()
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ");
  if (collapsed.length === 0) return collapsed;

  const titled = collapsed
    .split(" ")
    .map((token) => {
      // Preserve a trailing comma on the token while casing the word.
      const trailingComma = token.endsWith(",");
      const word = trailingComma ? token.slice(0, -1) : token;
      const cased = caseAddressWord(word);
      return trailingComma ? cased + "," : cased;
    })
    .join(" ");

  return titled;
}

/** Case a single address word: state codes upper, ZIPs/numbers as-is, else title. */
function caseAddressWord(word: string): string {
  if (word.length === 0) return word;

  const upper = word.toUpperCase();
  // 2-letter state code → upper-case (only when it's actually a known state).
  if (word.length === 2 && STATE_ABBREVIATIONS.has(upper)) {
    return upper;
  }
  // Tokens that contain a digit (street numbers, ZIPs, unit numbers, "37920",
  // "123", "B12") — leave exactly as typed.
  if (/\d/.test(word)) return word;

  // Default: title-case (lowercase rest), reusing the name-segment rule so
  // apostrophes/hyphens in street names ("O'Connor", "Martin-Luther") read well.
  return word
    .split("-")
    .map((p) => capitalizeSegment(p))
    .join("-");
}

/** Trim + collapse-whitespace an email and lower-case it (emails are case- *
 * insensitive in the domain, and effectively so for the vast majority of
 * mailbox providers; lower-casing makes dedupe and display consistent). */
export function sanitizeEmail(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toLowerCase();
}

/** The contact fields a sanitizer pass touches (null/undefined pass through). */
export interface ContactFields {
  readonly customerName?: string | null;
  readonly customerPhone?: string | null;
  readonly customerEmail?: string | null;
  readonly address?: string | null;
}

/**
 * Apply the per-field sanitizers to a contact-bearing object, returning a NEW
 * object with the cleaned values (immutable — never mutates the input). A
 * null/undefined/blank value is left as-is so this is safe to call on partially
 * filled slots every turn. Only the four contact fields are touched; any other
 * properties on the spread input are preserved untouched.
 */
export function sanitizeContactFields<T extends ContactFields>(input: T): T {
  const clean = <V extends string | null | undefined>(
    value: V,
    fn: (s: string) => string,
  ): V => (typeof value === "string" && value.trim().length > 0 ? (fn(value) as V) : value);

  return {
    ...input,
    customerName: clean(input.customerName, sanitizeName),
    customerPhone: clean(input.customerPhone, sanitizePhone),
    customerEmail: clean(input.customerEmail, sanitizeEmail),
    address: clean(input.address, sanitizeAddress),
  };
}
