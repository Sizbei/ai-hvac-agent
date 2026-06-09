/**
 * Detect when a captured "name" is actually a BUSINESS rather than a person.
 *
 * Spears Services is commercial-first, so a caller often gives a company name
 * ("McDonald's", "Joe's Diner", "Acme Refrigeration LLC") when asked for a name.
 * When we spot that, the chat route pre-sets propertyType=commercial and the bot
 * confirms it's a commercial unit — instead of treating the company as a
 * person's first/last name and asking residential questions.
 *
 * Pure heuristic, no I/O. Conservative on the false-positive side for genuine
 * surnames: a plain "Brian Hoang" or "Mary Mcdonald" (with a first name) is NOT
 * flagged; only signals that strongly indicate a business are.
 */

// Legal-entity / business suffixes (word-boundary matched, case-insensitive).
const ENTITY_SUFFIXES = [
  "llc",
  "l.l.c",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "lp",
  "llp",
  "pllc",
  "group",
  "holdings",
  "enterprises",
  "industries",
  "services",
];

// Industry / venue words that signal a commercial establishment.
const BUSINESS_WORDS = [
  "restaurant",
  "diner",
  "cafe",
  "café",
  "grill",
  "bar",
  "pub",
  "tavern",
  "bakery",
  "deli",
  "bistro",
  "kitchen",
  "eatery",
  "pizzeria",
  "steakhouse",
  "buffet",
  "hotel",
  "motel",
  "inn",
  "lodge",
  "market",
  "grocery",
  "store",
  "shop",
  "mart",
  "supermarket",
  "hospital",
  "clinic",
  "school",
  "church",
  "office",
  "warehouse",
  "plant",
  "factory",
  "brewery",
  "winery",
  "creamery",
  "convenience",
];

// A small set of well-known chains people give as a bare brand. Not exhaustive —
// the suffix/word heuristics catch the long tail; these catch common bare brands
// that have no entity suffix or industry word.
const KNOWN_CHAINS = [
  "mcdonald",
  "mcdonalds",
  "wendy",
  "wendys",
  "burger king",
  "subway",
  "starbucks",
  "dunkin",
  "kfc",
  "taco bell",
  "chick-fil-a",
  "chick fil a",
  "chickfila",
  "walmart",
  "wal-mart",
  "target",
  "kroger",
  "publix",
  "costco",
  "wendy's",
  "domino",
  "dominos",
  "pizza hut",
  "arby",
  "arbys",
  "hardee",
  "hardees",
  "sonic",
  "ihop",
  "denny",
  "dennys",
  "cracker barrel",
  "waffle house",
];

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * True when `name` looks like a business/organization rather than a person.
 *
 * Signals (any one is enough):
 *  - a legal-entity suffix token (LLC, Inc, Corp, Co, Ltd, …)
 *  - an industry/venue word (Restaurant, Diner, Hotel, Market, …)
 *  - a known chain brand (McDonald's, Walmart, …)
 *  - a SINGLE possessive token with no first name ("McDonald's", "Joe's") —
 *    "<First> <Last>" with a possessive is treated as a person to stay safe.
 */
export function isBusinessName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  const ts = tokens(name);
  if (ts.length === 0) return false;

  // Legal-entity suffix as a standalone token ("… LLC", "… Inc").
  if (ts.some((t) => ENTITY_SUFFIXES.includes(t))) return true;

  // Industry/venue word as a standalone token ("… Diner", "… Hotel").
  if (ts.some((t) => BUSINESS_WORDS.includes(t))) return true;

  // A lone possessive token with no separate first name: "McDonald's", "Joe's".
  // A two-token "<First> <Last>" person is NOT flagged (a surname ending in 's
  // after a first name reads as a person).
  if (ts.length === 1 && /['’]s$/.test(ts[0])) return true;

  // Known chain brand — but ONLY as a bare brand the customer gave AS the
  // business, not as a surname after a first name. We require the brand to be
  // possessive ("McDonald's"), or to START the name, or to be the entire name.
  // This keeps "Mary McDonald" (a person) from matching the "mcdonald" chain.
  const startsWithChain = KNOWN_CHAINS.some(
    (c) => lower === c || lower.startsWith(c + " ") || lower.startsWith(c + "'") || lower.startsWith(c + "’"),
  );
  if (startsWithChain) return true;
  // "the Walmart on Main" — chain as a token, with a leading article/determiner.
  if (ts.length > 0 && ["the", "a"].includes(ts[0])) {
    if (KNOWN_CHAINS.some((c) => lower.includes(c))) return true;
  }

  return false;
}
