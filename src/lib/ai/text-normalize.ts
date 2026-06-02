/**
 * Shared message normalization for the deterministic router and any matcher
 * that compares against router-normalized text (e.g. custom-FAQ triggers).
 * Kept in its own module so both intent-router.ts and router-config.ts can use
 * it without a circular import.
 */

// Alias map applied during normalization AFTER punctuation has been stripped to
// spaces. So "a/c" and "a.c." arrive here as "a c".
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
