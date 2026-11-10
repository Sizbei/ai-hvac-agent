/**
 * Source scanner for the hidden-history coverage test. Pure: takes a path and
 * its text, returns every top-level chunk that reads a flagged table (one with
 * `hidden_from_org`) or a child of one, and which of those reads are not
 * covered by a visibility filter in the same chunk.
 *
 * It is a lexical heuristic, not a parser: comments and strings count. Reads
 * are `.from(T`, `Join(T`, `.query.T`, raw `FROM|JOIN t [alias]` (snake names,
 * any case) and `FROM|JOIN ${T} [alias]`.
 */

/** Drizzle name → snake (SQL) name. */
const FLAGGED: Readonly<Record<string, string>> = {
  customers: "customers",
  serviceRequests: "service_requests",
  invoices: "invoices",
  estimates: "estimates",
  customerSessions: "customer_sessions",
};

const CHILD: Readonly<Record<string, string>> = {
  payments: "payments",
  customerEquipment: "customer_equipment",
  messages: "messages",
  appointments: "appointments",
  reviewRequests: "review_requests",
  communicationJobs: "communication_jobs",
  requestNotes: "request_notes",
  customerNotes: "customer_notes",
  attachments: "attachments",
  refunds: "refunds",
  customerLocations: "customer_locations",
};

function bothNames(map: Readonly<Record<string, string>>): readonly string[] {
  return [...new Set(Object.entries(map).flat())];
}

export const FLAGGED_TABLES: readonly string[] = bothNames(FLAGGED);
export const CHILD_TABLES: readonly string[] = bothNames(CHILD);

export interface ReadSite {
  readonly id: string;
  readonly reads: readonly { table: string; alias: string | null; kind: "flagged" | "child" }[];
  readonly uncovered: readonly string[];
}

type Read = ReadSite["reads"][number] & { readonly written: string; readonly raw: boolean };

type Kind = ReadSite["reads"][number]["kind"];

function byName(map: Readonly<Record<string, string>>, kind: Kind) {
  return Object.entries(map).flatMap(([drizzle, snake]) => [
    [drizzle, { snake, kind }] as const,
    [snake, { snake, kind }] as const,
  ]);
}

/** Either name → its snake name and kind. */
const SNAKE: ReadonlyMap<string, { snake: string; kind: Kind }> = new Map([
  ...byName(FLAGGED, "flagged"),
  ...byName(CHILD, "child"),
]);

// Longest first so `customerSessions` is tried before `customers`; the
// lookahead stops `customer_locations` / `invoice_lines` from matching.
const alternation = (names: Iterable<string>) =>
  [...names].sort((a, b) => b.length - a.length).join("|");
const NAMES = alternation(SNAKE.keys());
/** Raw SQL names its tables in snake case; drizzle tables arrive via `${}`. */
const SQL_NAMES = alternation(new Set([...SNAKE.values()].map((t) => t.snake)));
const END = "(?![\\w$])";
const ALIAS = "(?:\\s+(?:as\\s+)?([A-Za-z_]\\w*))?";

const DRIZZLE_READ = new RegExp(
  `(?:\\.from\\(\\s*|Join\\(\\s*|\\.query\\.)(${NAMES})${END}`,
  "g",
);
const RAW_READ = new RegExp(`\\b(?:from|join)\\s+(${SQL_NAMES})${END}${ALIAS}`, "gi");
const TEMPLATE_READ = new RegExp(`\\b(?:from|join)\\s+\\$\\{(?:schema\\.)?(${NAMES})\\}${ALIAS}`, "gi");

/** Words that can follow a table in SQL and are never its alias. */
const NOT_ALIAS = new Set([
  "as", "on", "using", "where", "join", "inner", "left", "right", "full", "outer",
  "cross", "natural", "lateral", "group", "order", "limit", "offset", "having",
  "window", "union", "intersect", "except", "returning", "set", "values", "and",
  "or", "not", "in", "is", "for", "with", "select", "from", "fetch", "tablesample",
]);

const CHUNK_START =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/;

function chunks(source: string): { name: string; text: string }[] {
  const out: { name: string; lines: string[] }[] = [{ name: "(top)", lines: [] }];
  for (const line of source.split("\n")) {
    const m = CHUNK_START.exec(line);
    if (m) out.push({ name: m[1] ?? m[2], lines: [] });
    out[out.length - 1].lines.push(line);
  }
  return out.map((c) => ({ name: c.name, text: c.lines.join("\n") }));
}

function lookup(written: string) {
  return SNAKE.get(written) ?? SNAKE.get(written.toLowerCase());
}

function findReads(text: string): Read[] {
  const found: { index: number; read: Read }[] = [];
  const add = (index: number, written: string, alias: string | undefined, raw: boolean) => {
    const t = lookup(written);
    if (!t) return;
    const a = alias && !NOT_ALIAS.has(alias.toLowerCase()) ? alias : null;
    found.push({ index, read: { table: t.snake, alias: a, kind: t.kind, written, raw } });
  };
  for (const m of text.matchAll(DRIZZLE_READ)) add(m.index, m[1], undefined, false);
  for (const m of text.matchAll(RAW_READ)) add(m.index, m[1], m[2], true);
  for (const m of text.matchAll(TEMPLATE_READ)) add(m.index, m[1], m[2], true);
  return found.sort((a, b) => a.index - b.index).map((f) => f.read);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drizzle reads count `visibleRows(T,`; raw reads count `visibleRowsSql("<alias or table>",`. */
function filterKey(read: Read): { key: string; pattern: RegExp } {
  if (!read.raw) {
    return { key: `d:${read.written}`, pattern: new RegExp(`visibleRows\\(\\s*${escape(read.written)}\\s*,`, "g") };
  }
  const name = read.alias ?? read.table;
  return { key: `r:${name}`, pattern: new RegExp(`visibleRowsSql\\(\\s*(["'])${escape(name)}\\1\\s*,`, "g") };
}

/**
 * Coverage is per read: a flagged read key read N times needs N filter calls
 * naming it, and the chunk's child reads need as many filtered parent reads.
 */
function uncoveredTables(reads: readonly Read[], text: string): string[] {
  const groups = new Map<string, { pattern: RegExp; reads: Read[] }>();
  for (const read of reads.filter((r) => r.kind === "flagged")) {
    const { key, pattern } = filterKey(read);
    const group = groups.get(key) ?? { pattern, reads: [] };
    group.reads.push(read);
    groups.set(key, group);
  }
  const uncovered: string[] = [];
  let filteredParents = 0;
  for (const { pattern, reads: group } of groups.values()) {
    const filters = text.match(pattern)?.length ?? 0;
    filteredParents += Math.min(filters, group.length);
    if (filters < group.length) uncovered.push(group[0].table);
  }
  const children = reads.filter((r) => r.kind === "child");
  if (children.length > filteredParents) uncovered.push(...children.map((r) => r.table));
  return uncovered;
}

export function scanSource(path: string, source: string): ReadSite[] {
  const sites: ReadSite[] = [];
  for (const chunk of chunks(source)) {
    const reads = findReads(chunk.text);
    if (reads.length === 0) continue;
    sites.push({
      id: `${path}#${chunk.name}`,
      reads: reads.map(({ table, alias, kind }) => ({ table, alias, kind })),
      uncovered: [...new Set(uncoveredTables(reads, chunk.text))],
    });
  }
  return sites;
}
