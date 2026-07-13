export type CommandItem = {
  label: string;
  href: string;
  group: string;
};

/**
 * Returns true if every character in `needle` appears in `haystack`
 * in order (case-insensitive subsequence check).
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const found = haystack.indexOf(needle[ni], hi);
    if (found === -1) return false;
    hi = found + 1;
  }
  return true;
}

/**
 * Rank a label against a query. Lower value = better match.
 *  0 — exact match
 *  1 — prefix match (label starts with query)
 *  2 — word-boundary match (any word in label starts with query)
 *  3 — substring match (query appears anywhere in label)
 *  4 — subsequence match
 * -1 — no match
 */
function rank(query: string, label: string): number {
  const q = query.toLowerCase();
  const l = label.toLowerCase();

  if (l === q) return 0;
  if (l.startsWith(q)) return 1;

  // Word-boundary: any space-separated word starts with q
  const words = l.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 2;

  if (l.includes(q)) return 3;

  if (isSubsequence(q, l)) return 4;

  return -1;
}

/**
 * Filter and rank `items` against `query`.
 * - Empty query returns all items in original order.
 * - Case-insensitive.
 * - Ranks: exact → prefix → word-boundary → substring → subsequence.
 * - Stable within each rank tier (preserves input order).
 */
export function filterCommands(
  query: string,
  items: readonly CommandItem[],
): CommandItem[] {
  if (query.trim() === '') return [...items];

  const ranked: Array<{ item: CommandItem; rank: number; index: number }> = [];

  for (let i = 0; i < items.length; i++) {
    const r = rank(query, items[i].label);
    if (r !== -1) {
      ranked.push({ item: items[i], rank: r, index: i });
    }
  }

  // Sort by rank first, then by original index (stable within tier)
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

  return ranked.map((r) => r.item);
}
