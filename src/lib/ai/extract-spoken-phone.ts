/**
 * Voice-only spoken-phone-number fallback.
 *
 * Twilio's speech recognition usually transcribes a phone number in a grouped
 * form the shared `extractPhone` regex already matches ("865 555 1212"). But a
 * caller who reads the number digit-by-digit ("eight six five, five five five,
 * one two one two") is often transcribed as a loose run of single digits
 * ("8 6 5 5 5 5 1 2 1 2") — or with stray filler words — that the strict
 * grouped regex misses. On a call there's no keyboard to fall back to, so a
 * missed number means re-asking.
 *
 * This helper is deliberately narrow and used ONLY when the pending step is the
 * phone step (so the conversational context guarantees the reply is meant to be
 * a phone number). It strips everything but digits and accepts the result only
 * when it is a clean 10-digit US number, or 11 digits with a leading country
 * code `1`. It never loosens the shared `extractPhone` used by the web chat.
 */

/** Format 10 significant digits as "XXX-XXX-XXXX". */
function formatUsPhone(tenDigits: string): string {
  return `${tenDigits.slice(0, 3)}-${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
}

/**
 * Extract a phone number from a spoken/transcribed reply by reducing it to its
 * digits. Returns a normalized "XXX-XXX-XXXX" string when the utterance carries
 * exactly a US phone's worth of digits (10, or 11 with a leading 1), else null.
 *
 * Use only at the phone step — elsewhere a stray run of digits (a ZIP plus a
 * unit number, a date read aloud) could coincidentally total ten.
 */
const WORD_DIGITS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * Replace spoken digit words with numerals ("four two three" → "4 2 3").
 * Twilio usually transcribes read-out numbers as numerals, but word-by-word
 * transcriptions do occur — without this, a caller's spoken number never
 * parses and the phone question loops.
 */
function wordsToDigits(message: string): string {
  return message
    .toLowerCase()
    .split(/[\s,.-]+/)
    .map((token) => WORD_DIGITS[token] ?? token)
    .join(" ");
}

export function extractSpokenPhone(message: string): string | null {
  const digits = wordsToDigits(message).replace(/\D/g, "");

  if (digits.length === 10) {
    return formatUsPhone(digits);
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return formatUsPhone(digits.slice(1));
  }
  return null;
}
