/**
 * Pure environment-helpers — NO db / server-only imports.
 * Safe to import from both server components and client components.
 */

/** The name of the current environment, lower-cased. Defaults to 'production'. */
export function envName(): string {
  return (process.env.NEXT_PUBLIC_ENV_NAME ?? '').toLowerCase() || 'production';
}

export type EnvTone = 'destructive' | 'warning' | 'positive';

/**
 * Maps an env name to a Tailwind tone bucket:
 *   production → destructive (red)
 *   staging    → warning (amber)
 *   anything else (test / dev / …) → positive (green)
 */
export function envTone(name: string): EnvTone {
  const n = name.toLowerCase();
  if (n === 'production') return 'destructive';
  if (n === 'staging') return 'warning';
  return 'positive';
}

/** Stable sort order for well-known env names. Higher = earlier. */
const ENV_ORDER: Record<string, number> = {
  production: 3,
  staging: 2,
  test: 1,
};

/**
 * Parses `NEXT_PUBLIC_ENV_LINKS` JSON (shape: `{ name: url }`) into a sorted
 * array of `{ name, url }` links.
 *
 * - Drops the entry matching `self` (case-insensitive name match).
 * - Drops entries whose URL is not http(s).
 * - On malformed JSON returns [].
 * - Order: production, staging, test, then remaining alphabetically.
 */
export function parseEnvLinks(
  json: string | undefined,
  self: string,
): { name: string; url: string }[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const selfLower = self.toLowerCase();
  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter(([name, url]) => {
      if (typeof url !== 'string') return false;
      if (name.toLowerCase() === selfLower) return false;
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    })
    .map(([name, url]) => ({ name, url: url as string }));

  return entries.sort((a, b) => {
    const aOrder = ENV_ORDER[a.name.toLowerCase()] ?? 0;
    const bOrder = ENV_ORDER[b.name.toLowerCase()] ?? 0;
    if (aOrder !== bOrder) return bOrder - aOrder;
    return a.name.localeCompare(b.name);
  });
}
