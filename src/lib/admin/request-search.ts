/**
 * LIKE patterns for the request list's reference search. References are
 * "HVAC-1A2B3C4D", but dispatchers type the part they read off a screen
 * ("1a2b"), so a term without the prefix also matches with "HVAC-" in front.
 * Every pattern is a prefix match (index-friendly) with LIKE metacharacters
 * escaped. An empty term returns no patterns (no search).
 */
const REFERENCE_PREFIX = "HVAC-";

export function referenceSearchPatterns(term: string | null | undefined): readonly string[] {
  const trimmed = term?.trim() ?? "";
  if (!trimmed) return [];
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  if (trimmed.toUpperCase().startsWith(REFERENCE_PREFIX)) return [`${escaped}%`];
  return [`${escaped}%`, `${REFERENCE_PREFIX}${escaped}%`];
}
