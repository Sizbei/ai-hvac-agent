/**
 * Go-live junk cleanup: hide the test, demo and placeholder rows that would
 * look unprofessional in the org's view (staff trying out FieldPulse, chatbot
 * test traffic from before go-live). Pure: list validation and the hide plan.
 * The script (scripts/agent/golive-hide-junk.mjs) fetches rows, asks
 * `planJunk` what to change, and runs the UPDATEs. Nothing here deletes a row.
 *
 * Keys must mean the same row on dev and prod:
 * - imported rows: the FieldPulse id (a request's reference_number is minted
 *   per database, so it differs for FieldPulse jobs);
 * - native requests: the reference number;
 * - native customers: the row id. Rows created before the dev branch split
 *   (2026-07-09) share ids and reference numbers with prod; later dev rows
 *   simply aren't found on prod.
 *
 * Real money is an invoice synced from FieldPulse or Housecall Pro, or one
 * with a payment from a real provider (the script reports demo `mock`
 * payments as $0 paid). The plan enforces, whatever the list says:
 * - an invoice with real money paid on it is never hidden;
 * - a test request's (or test customer's) own invoices and estimates go with
 *   it unless they are synced and priced; those are kept for review (list one
 *   by its FieldPulse id to hide it anyway);
 * - a listed customer is hidden only when ALL its requests, invoices and
 *   estimates are hidden; otherwise it and its unlisted rows stay;
 * - a conversation is hidden only when every request on it is hidden.
 */

export interface JunkEntry {
  readonly key: string;
  readonly reason: string;
}

export interface JunkList {
  readonly requests: readonly JunkEntry[];
  readonly customers: readonly JunkEntry[];
  readonly invoices: readonly JunkEntry[];
  readonly estimates: readonly JunkEntry[];
  readonly pricebookItems: readonly JunkEntry[];
}

export const JUNK_SECTIONS = ["requests", "customers", "invoices", "estimates", "pricebookItems"] as const;
type Section = (typeof JUNK_SECTIONS)[number];

const FP_ID = /^[0-9]{1,15}$/;
const REFERENCE = /^HVAC-[A-Z0-9]{4,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function keyIsValid(section: Section, key: string): boolean {
  if (FP_ID.test(key)) return true;
  if (section === "requests") return REFERENCE.test(key);
  if (section === "customers") return UUID.test(key);
  return false;
}

/** Validate the list file's JSON. Throws with a plain message on the first bad entry. */
export function parseJunkList(raw: unknown): JunkList {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("junk list must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const unknownSection = Object.keys(obj).find((k) => k !== "$comment" && !(JUNK_SECTIONS as readonly string[]).includes(k));
  if (unknownSection) throw new Error(`junk list has an unknown section "${unknownSection}"`);

  const parsed = {} as Record<Section, JunkEntry[]>;
  for (const section of JUNK_SECTIONS) {
    const entries = obj[section] ?? [];
    if (!Array.isArray(entries)) throw new Error(`junk list "${section}" must be an array`);
    const seen = new Set<string>();
    parsed[section] = entries.map((entry, i) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const key = typeof e.key === "string" ? e.key.trim() : "";
      const reason = typeof e.reason === "string" ? e.reason.trim() : "";
      if (!keyIsValid(section, key)) throw new Error(`junk list ${section}[${i}]: bad key "${key}"`);
      if (!reason) throw new Error(`junk list ${section}[${i}]: a reason is required`);
      if (seen.has(key)) throw new Error(`junk list ${section}[${i}]: duplicate key "${key}"`);
      seen.add(key);
      return { key, reason };
    });
  }
  return parsed;
}

export interface KeyedRow {
  readonly id: string;
  /** The list key this row matched (FieldPulse id, reference number or row id). */
  readonly key: string;
}
export interface MoneyRow {
  readonly id: string;
  readonly fieldpulseId: string | null;
  readonly requestId: string | null;
  readonly customerId: string | null;
  readonly totalCents: number;
  /** Real money paid (0 for estimates and for demo `mock` payments). */
  readonly paidCents: number;
  /** Synced from FieldPulse or Housecall Pro. */
  readonly synced: boolean;
}
export interface CustomerRequests {
  readonly customerId: string;
  readonly requestIds: readonly string[];
}
export interface SessionRow {
  readonly id: string;
  readonly requestIds: readonly string[];
}

/**
 * What the script read: the listed rows, every invoice/estimate that is listed
 * or sits on a listed request or customer, each listed customer's requests,
 * and the conversations of the listed requests.
 */
export interface JunkSnapshot {
  readonly requests: readonly KeyedRow[];
  readonly invoices: readonly MoneyRow[];
  readonly estimates: readonly MoneyRow[];
  readonly customers: readonly KeyedRow[];
  readonly customerRequests: readonly CustomerRequests[];
  readonly sessions: readonly SessionRow[];
  readonly pricebookItems: readonly KeyedRow[];
}

export interface JunkPlan {
  readonly requestIds: readonly string[];
  readonly invoiceIds: readonly string[];
  readonly estimateIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly pricebookIds: readonly string[];
  /** List keys with no row in this database (fine: dev and prod hold different rows). */
  readonly notFound: readonly string[];
  /** Rows the plan refused to hide, and why. Review these by hand. */
  readonly kept: readonly string[];
}

type MoneyVerdict = "listed" | "follows" | "kept";

/** Whether a money row may be hidden: listed outright, or following its test parent. */
function moneyVerdict(row: MoneyRow, listed: ReadonlySet<string>): MoneyVerdict {
  if (row.paidCents > 0) return "kept";
  if (row.fieldpulseId !== null && listed.has(row.fieldpulseId)) return "listed";
  return row.synced && row.totalCents !== 0 ? "kept" : "follows";
}

function matched(section: Section, list: JunkList, rows: readonly KeyedRow[], notFound: string[]): KeyedRow[] {
  const keys = new Set(list[section].map((e) => e.key));
  const hits = rows.filter((r) => keys.has(r.key));
  const have = new Set(hits.map((r) => r.key));
  for (const e of list[section]) if (!have.has(e.key)) notFound.push(`${section} ${e.key}`);
  return hits;
}

/** Decide which rows to hide. Pure; reads no hidden flags, so --apply and --undo agree. */
export function planJunk(list: JunkList, snap: JunkSnapshot): JunkPlan {
  const kept: string[] = [];
  const notFound: string[] = [];

  const requestIds = new Set(matched("requests", list, snap.requests, notFound).map((r) => r.id));
  const customers = matched("customers", list, snap.customers, notFound);
  const items = matched("pricebookItems", list, snap.pricebookItems, notFound);

  const money = (section: "invoices" | "estimates", rows: readonly MoneyRow[]) => {
    const listed = new Set(list[section].map((e) => e.key));
    const have = new Set(rows.flatMap((r) => (r.fieldpulseId ? [r.fieldpulseId] : [])));
    for (const e of list[section]) if (!have.has(e.key)) notFound.push(`${section} ${e.key}`);
    return rows.map((row) => ({ row, verdict: moneyVerdict(row, listed), section }));
  };
  const moneyRows = [...money("invoices", snap.invoices), ...money("estimates", snap.estimates)];

  // A listed customer goes only when every request and money row of theirs goes.
  const requestsOf = new Map(snap.customerRequests.map((c) => [c.customerId, c.requestIds]));
  const customerIds = new Set<string>();
  for (const c of customers) {
    const otherRequests = (requestsOf.get(c.id) ?? []).filter((id) => !requestIds.has(id)).length;
    const keptMoney = moneyRows.filter((m) => m.row.customerId === c.id && m.verdict === "kept").length;
    if (otherRequests + keptMoney > 0) {
      kept.push(`customers ${c.key}: ${otherRequests} other requests and ${keptMoney} priced or paid invoices/estimates, kept`);
    } else {
      customerIds.add(c.id);
    }
  }

  const hidden: Record<"invoices" | "estimates", string[]> = { invoices: [], estimates: [] };
  for (const { row, verdict, section } of moneyRows) {
    const onTestParent =
      (row.requestId !== null && requestIds.has(row.requestId)) || (row.customerId !== null && customerIds.has(row.customerId));
    const name = `${section} ${row.fieldpulseId ?? row.id}`;
    if (verdict === "listed" || (verdict === "follows" && onTestParent)) hidden[section].push(row.id);
    else if (verdict === "kept" && (onTestParent || (row.fieldpulseId !== null && list[section].some((e) => e.key === row.fieldpulseId)))) {
      kept.push(row.paidCents > 0 ? `${name}: money paid on it, kept` : `${name}: synced and priced, kept (list it to hide)`);
    }
  }

  const sessionIds = snap.sessions
    .filter((s) => s.requestIds.length > 0 && s.requestIds.every((id) => requestIds.has(id)))
    .map((s) => s.id);

  return {
    requestIds: [...requestIds],
    invoiceIds: hidden.invoices,
    estimateIds: hidden.estimates,
    customerIds: [...customerIds],
    sessionIds,
    pricebookIds: items.map((p) => p.id),
    notFound,
    kept,
  };
}
