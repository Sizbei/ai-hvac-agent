/**
 * Pure helpers for syncing list-filter state to the URL query string.
 * Used by useUrlFilterSync (History-API based, no useSearchParams → no Suspense
 * boundary needed, so it can't break the build). Kept pure for easy testing.
 */

/**
 * Build a query string from key→value pairs, OMITTING empty/undefined values so
 * default filters never clutter the URL. Returns "" when nothing is set, else
 * "?a=1&b=2". Values are the caller's already-stringified filter values (pass ""
 * for a filter that is at its default so it's dropped).
 */
export function toQueryString(
  params: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  // Sort keys for a stable, deterministic string (nice for tests + no history churn).
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v !== undefined && v !== '') sp.set(key, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Parse a URL search string ("?a=1&b=2" or "a=1&b=2") into a plain object.
 * Only the last value wins for repeated keys. Empty string → {}.
 */
export function fromQueryString(search: string): Record<string, string> {
  const sp = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

/**
 * Query keys the filter sync carries over: the quick tour's back-to-tour strip
 * reads them (onboarding spec D4), and a client navigation can remount the page
 * after the sync's first write, so dropping them would lose the strip.
 */
const PRESERVED_KEYS = ['from', 'lesson', 'replay'] as const;

/**
 * The query string useUrlFilterSync writes: the page's filter params plus any
 * preserved key present in `currentSearch`. A filter of the same name wins.
 */
export function filterSyncSearch(
  params: Record<string, string | undefined>,
  currentSearch: string,
): string {
  const current = fromQueryString(currentSearch);
  const preserved: Record<string, string> = {};
  for (const key of PRESERVED_KEYS) {
    if (!(key in params) && current[key]) preserved[key] = current[key];
  }
  return toQueryString({ ...preserved, ...params });
}
