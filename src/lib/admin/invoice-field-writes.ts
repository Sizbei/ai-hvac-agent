/**
 * Field invoice writers (spec §5.1–5.4): adopt-or-create the request's draft,
 * add/remove lines while draft, finalize draft → open with the fresh-signature
 * snapshot. Each write is ONE db.batch (neon-http: one transaction), lock-first
 * L_req → L_inv; gated statements use xmin or an explicit EXISTS; outcomes are
 * read from the batch's own final SELECTs. Payment/refund writers live in
 * `./invoice-payment-writes` and import the shared SQL builders exported here.
 *
 * Actor: a technician (requestId + techUserId) gets the in-write lead check and
 * the request predicate; the office (techUserId null) gets TRUE for both, the
 * invoice's own request for L_req, and a synced-invoice pre-read.
 */
import { sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "@/lib/db";
import { getDefaultTaxBps, getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { materialLineId } from "@/lib/http/idempotency";
import { isDeadlock } from "@/lib/tech/status-writes";
import { SIGNABLE_IN } from "@/lib/tech/field-queries";
import { billedSql, billingInvoiceIdSql, eidParam, statusInSql } from "@/lib/admin/estimate-billing-sql";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";

export type FieldReason =
  | "managed_externally" | "external_invoice" | "not_lead" | "invoice_not_found" | "invoice_voided"
  | "invoice_locked" | "no_lines" | "already_billed" | "item_not_found" | "invoice_not_chargeable"
  | "exceeds_balance" | "synced_read_only" | "payment_id_conflict" | "refund_id_conflict" | "stale" | "from_estimate";

export interface Actor { organizationId: string; requestId: string | null; techUserId: string | null }

// ---------------------------------------------------------------- shared SQL builders
// Every fragment holding an OR is parenthesised; every enum literal is cast;
// organization_id is bound on every table reference.

/** Adopt predicate: a live (draft or open) invoice. Parenthesised: it holds an OR. */
export const P_LIVE: SQL = sql.raw("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");

/** Native predicate: not a FieldPulse/HCP mirror row. */
export const P_NATIVE: SQL = sql.raw("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");

/** L_req — first statement of every batch on a request. */
export function lockRequestSql(org: string, rid: string): SQL {
  return sql`SELECT 1 FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`;
}

/** L_inv — after L_req, before any row it guards. */
export function lockInvoiceSql(org: string, inv: string): SQL {
  return sql`SELECT 1 FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`;
}

/** In-write lead check: lead on any live visit of the request (spec §5). */
export function stillLeadSql(org: string, rid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id
    WHERE p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND a.organization_id = ${org}::uuid
      AND p.cancelled_at IS NULL AND a.technician_id = ${me}::uuid AND a.is_lead AND a.status IN ${SIGNABLE_IN})`;
}

/**
 * T(gate): recompute the invoice totals from its lines. `updated_at` moves only
 * when the subtotal OR the total changed (a tax-rate change moves the total
 * alone), so a replay, a refused attempt or an already-gone removal never makes
 * a fresh signature stale before finalize, and a signature never stays fresh
 * over a different total. The tax is computed once in the subquery (one param).
 */
export function totalsSql(org: string, inv: string, taxBps: number, gate: SQL): SQL {
  return sql`UPDATE invoices SET subtotal_cents = s.sub,
      tax_cents = s.tax,
      total_cents = s.sub + s.tax,
      updated_at = CASE WHEN invoices.subtotal_cents <> s.sub OR invoices.total_cents <> s.sub + s.tax THEN now() ELSE invoices.updated_at END
    FROM (SELECT t.sub, ROUND(t.sub * ${taxBps}::int / 10000.0)::int AS tax
      FROM (SELECT COALESCE(SUM(line_total_cents), 0) AS sub FROM invoice_line_items WHERE invoice_id = ${inv}::uuid AND organization_id = ${org}::uuid) t) s
    WHERE invoices.id = ${inv}::uuid AND invoices.organization_id = ${org}::uuid AND ${gate}`;
}

/** The material (`materialRef` is a uuid expression) is already on a non-void native invoice of the request. */
export function materialBilledSql(org: string, rid: string, materialRef: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id
    WHERE l.job_material_id = ${materialRef} AND l.organization_id = ${org}::uuid AND i.organization_id = ${org}::uuid
      AND i.service_request_id = ${rid}::uuid AND i.state <> 'void'::invoice_state
      AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL)`;
}

/** Line name for a material: the catalog item's name, else its description (manual rows have no `pi`). */
export const MATERIAL_NAME: SQL = sql.raw("COALESCE(pi.name, m.description, 'Material')");

// ---------------------------------------------------------------- internals

type Row = Record<string, unknown>;
type Fail = { ok: false; reason: FieldReason };
type InvoiceState = "draft" | "open" | "paid" | "refunded";

const fail = (reason: FieldReason): Fail => ({ ok: false, reason });
const LINE_COLUMNS = sql.raw("(id, organization_id, invoice_id, job_material_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)");
const XMIN_GATE = sql.raw("invoices.xmin = pg_current_xact_id()::xid");
const LINE_GATE = sql.raw("invoices.state = 'draft'::invoice_state AND invoices.amount_paid_cents = 0");

export async function readRows(q: SQL): Promise<Row[]> {
  return ((await db.execute(q)) as unknown as { rows: Row[] }).rows;
}

/** One batch; a deadlock (40P01) is a stale write, never a 500. */
export async function runBatch(items: SQL[]): Promise<Row[][] | Fail> {
  try {
    const out = (await db.batch(items.map((q) => db.execute(q)) as never)) as unknown as { rows: Row[] }[];
    return out.map((r) => r.rows);
  } catch (error) {
    if (isDeadlock(error)) return fail("stale");
    throw error;
  }
}

/** The write scope: who checks the lead, which request is locked/predicated. */
type Scope = { org: string; rid: string | null; lead: SQL | null; ridPred: (col: string) => SQL };

async function resolveScope(actor: Actor, invoiceId: string): Promise<Scope | Fail> {
  const org = actor.organizationId;
  if (actor.techUserId !== null) {
    const rid = actor.requestId;
    if (rid === null) throw new Error("invoice writer: a technician actor needs a requestId");
    return { org, rid, lead: stillLeadSql(org, rid, actor.techUserId), ridPred: (col) => sql`${sql.raw(col)} = ${rid}::uuid` };
  }
  const [inv] = await readRows(sql`SELECT service_request_id,
      (fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL) AS synced
    FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid`);
  if (!inv) return fail("invoice_not_found");
  if (inv.synced) return fail("synced_read_only");
  return { org, rid: (inv.service_request_id as string | null) ?? null, lead: null, ridPred: () => sql.raw("TRUE") };
}

/** Index of the write statement: after L_inv, or after L_req + L_inv. */
const writeAt = (s: Scope): number => (s.rid !== null ? 2 : 1);
const leadOrAdmin = (s: Scope): SQL => s.lead ?? sql.raw("TRUE");
const locks = (s: Scope, inv: string): SQL[] =>
  s.rid !== null ? [lockRequestSql(s.org, s.rid), lockInvoiceSql(s.org, inv)] : [lockInvoiceSql(s.org, inv)];
const leadTail = (s: Scope): SQL[] => (s.lead ? [sql`SELECT (${s.lead}) AS still_lead`] : []);
/** The tech path's final still_lead SELECT (always the last statement); the office is always "lead". */
const stillLead = (s: Scope, rows: Row[][]): boolean => s.lead === null || rows[rows.length - 1]![0]?.still_lead === true;

type Material = { id: string; name: string; quantity: number; unit_price_cents: number; unit_cost_cents: number };
const MATERIAL_COLUMNS = sql`m.id, ${MATERIAL_NAME} AS name, m.quantity, m.unit_price_cents, m.unit_cost_cents`;
const MATERIAL_FROM = (org: string) =>
  sql`FROM job_materials m LEFT JOIN pricebook_items pi ON pi.id = m.pricebook_item_id AND pi.organization_id = ${org}::uuid`;

// ---------------------------------------------------------------- create

export async function createInvoiceFromJob(
  actor: Actor & { requestId: string; techUserId: string },
  ids: { invoiceId: string },
): Promise<{ ok: true; invoiceId: string; state: InvoiceState; created: boolean } | Fail> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const inv = ids.invoiceId;
  const [req] = await readRows(sql`SELECT r.customer_id, (r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL) AS native,
      EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = ${org}::uuid AND i.service_request_id = r.id
        AND (i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL)) AS external_invoice
    FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`);
  if (!req) return fail("stale");
  if (!req.native) return fail("managed_externally");
  if (req.external_invoice) return fail("external_invoice");
  const taxBps = await getDefaultTaxBps(org);
  const materials = (await readRows(sql`SELECT ${MATERIAL_COLUMNS} ${MATERIAL_FROM(org)}
    WHERE m.service_request_id = ${rid}::uuid AND m.organization_id = ${org}::uuid
      AND NOT ${materialBilledSql(org, rid, sql.raw("m.id"))}
    ORDER BY m.created_at, m.id`)) as unknown as Material[];

  const lead = stillLeadSql(org, rid, me);
  const items: SQL[] = [
    lockRequestSql(org, rid),
    sql`INSERT INTO invoices (id, organization_id, service_request_id, customer_id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents)
      SELECT ${inv}::uuid, ${org}::uuid, ${rid}::uuid, ${(req.customer_id as string | null) ?? null}::uuid, 'draft'::invoice_state, 0, 0, 0, 0
      WHERE (${lead}) AND NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid AND ${P_LIVE} AND ${P_NATIVE})
      ON CONFLICT DO NOTHING RETURNING id`,
  ];
  if (materials.length > 0) {
    const values = sql.join(materials.map((m) => {
      const qty = Number(m.quantity);
      const price = Number(m.unit_price_cents);
      return sql`(${materialLineId(inv, m.id)}::uuid, ${m.id}::uuid, ${m.name}::text, ${qty}::int, ${price}::int, ${Number(m.unit_cost_cents)}::int, ${qty * price}::int)`;
    }), sql`, `);
    items.push(sql`INSERT INTO invoice_line_items ${LINE_COLUMNS}
      SELECT v.id, ${org}::uuid, ${inv}::uuid, v.job_material_id, v.name, v.quantity, v.unit_price_cents, v.cost_cents, v.line_total_cents
      FROM (VALUES ${values}) AS v(id, job_material_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid AND xmin = pg_current_xact_id()::xid)
        AND NOT ${materialBilledSql(org, rid, sql.raw("v.job_material_id"))}
      ON CONFLICT (id) DO NOTHING`);
  }
  items.push(
    totalsSql(org, inv, taxBps, XMIN_GATE),
    sql`SELECT id, state FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid AND ${P_LIVE} AND ${P_NATIVE}
      ORDER BY created_at DESC LIMIT 1`,
    sql`SELECT (${lead}) AS still_lead`,
  );

  const rows = await runBatch(items);
  if (!Array.isArray(rows)) return rows;
  if (rows[1]!.length > 0) return { ok: true, invoiceId: inv, state: "draft", created: true };
  if (rows[rows.length - 1]![0]?.still_lead !== true) return fail("not_lead");
  const live = rows[rows.length - 2]![0];
  if (live) return { ok: true, invoiceId: live.id as string, state: live.state as InvoiceState, created: false };
  // No live invoice: this key's own invoice is history (paid/refunded) or was voided.
  const [mine] = await readRows(sql`SELECT state FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid`);
  if (mine?.state === "paid" || mine?.state === "refunded") return { ok: true, invoiceId: inv, state: mine.state, created: false };
  if (mine?.state === "void") return fail("invoice_voided");
  return fail("stale");
}

// ---------------------------------------------------------------- lines

type LineInput = { pricebookItemId: string; quantity: number } | { jobMaterialId: string };
type LineValues = { lineId: string; jobMaterialId: string | null; name: string; quantity: number; priceCents: number; costCents: number };

async function lineValues(s: Scope, invoiceId: string, lineId: string, input: LineInput): Promise<LineValues | null> {
  if ("pricebookItemId" in input) {
    const item = await getPricebookItemById(s.org, input.pricebookItemId);
    if (!item || !item.active) return null;
    return { lineId, jobMaterialId: null, name: item.name, quantity: input.quantity, priceCents: item.priceCents, costCents: item.costCents };
  }
  if (s.rid === null) return null;
  const [m] = (await readRows(sql`SELECT ${MATERIAL_COLUMNS} ${MATERIAL_FROM(s.org)}
    WHERE m.id = ${input.jobMaterialId}::uuid AND m.service_request_id = ${s.rid}::uuid AND m.organization_id = ${s.org}::uuid`)) as unknown as Material[];
  if (!m) return null;
  return {
    lineId: materialLineId(invoiceId, m.id), jobMaterialId: m.id, name: m.name,
    quantity: Number(m.quantity), priceCents: Number(m.unit_price_cents), costCents: Number(m.unit_cost_cents),
  };
}

const draftInvoiceExists = (s: Scope, inv: string, extra: SQL = sql``): SQL =>
  sql`EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${inv}::uuid AND i.organization_id = ${s.org}::uuid AND ${s.ridPred("i.service_request_id")}
    AND i.state = 'draft'::invoice_state AND ${P_NATIVE}${extra})`;

export async function addInvoiceLine(
  actor: Actor, invoiceId: string, ids: { lineId: string }, input: LineInput,
): Promise<{ ok: true; lineId: string; replayed?: true } | Fail> {
  const scope = await resolveScope(actor, invoiceId);
  if ("ok" in scope) return scope;
  const v = await lineValues(scope, invoiceId, ids.lineId, input);
  if (!v) return fail("item_not_found");
  const { org } = scope;
  const billed = v.jobMaterialId !== null && scope.rid !== null
    ? materialBilledSql(org, scope.rid, sql`${v.jobMaterialId}::uuid`)
    : null;
  const rows = await runBatch([
    ...locks(scope, invoiceId),
    sql`INSERT INTO invoice_line_items ${LINE_COLUMNS}
      SELECT ${v.lineId}::uuid, ${org}::uuid, ${invoiceId}::uuid, ${v.jobMaterialId}::uuid, ${v.name}, ${v.quantity}::int, ${v.priceCents}::int, ${v.costCents}::int, ${v.quantity * v.priceCents}::int
      WHERE (${leadOrAdmin(scope)}) AND ${draftInvoiceExists(scope, invoiceId)}${billed ? sql` AND NOT ${billed}` : sql``}
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    totalsSql(org, invoiceId, await getDefaultTaxBps(org), LINE_GATE),
    sql`SELECT state,
        EXISTS (SELECT 1 FROM invoice_line_items WHERE id = ${v.lineId}::uuid AND invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid) AS line_exists,
        ${billed ?? sql.raw("FALSE")} AS already_billed
      FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${scope.ridPred("service_request_id")}`,
    ...leadTail(scope),
  ]);
  if (!Array.isArray(rows)) return rows;
  const at = writeAt(scope);
  if (rows[at]!.length > 0) return { ok: true, lineId: v.lineId };
  if (!stillLead(scope, rows)) return fail("not_lead");
  const inv = rows[at + 2]![0];
  if (!inv) return fail("invoice_not_found");
  if (inv.line_exists === true) return { ok: true, lineId: v.lineId, replayed: true };
  if (inv.state !== "draft") return fail("invoice_locked");
  if (inv.already_billed === true) return fail("already_billed");
  return fail("stale");
}

export async function removeInvoiceLine(
  actor: Actor, invoiceId: string, lineId: string,
): Promise<{ ok: true; removed: boolean } | Fail> {
  const scope = await resolveScope(actor, invoiceId);
  if ("ok" in scope) return scope;
  const { org } = scope;
  const rows = await runBatch([
    ...locks(scope, invoiceId),
    sql`DELETE FROM invoice_line_items WHERE id = ${lineId}::uuid AND invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid
      AND estimate_line_item_id IS NULL AND (${leadOrAdmin(scope)}) AND ${draftInvoiceExists(scope, invoiceId, sql` AND i.amount_paid_cents = 0`)} RETURNING id`,
    totalsSql(org, invoiceId, await getDefaultTaxBps(org), LINE_GATE),
    sql`SELECT state, amount_paid_cents,
        EXISTS (SELECT 1 FROM invoice_line_items WHERE id = ${lineId}::uuid AND invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND estimate_line_item_id IS NOT NULL) AS from_estimate
      FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${scope.ridPred("service_request_id")}`,
    ...leadTail(scope),
  ]);
  if (!Array.isArray(rows)) return rows;
  const at = writeAt(scope);
  if (rows[at]!.length > 0) return { ok: true, removed: true };
  if (!stillLead(scope, rows)) return fail("not_lead");
  const inv = rows[at + 2]![0];
  if (!inv) return fail("invoice_not_found");
  if (inv.state !== "draft" || Number(inv.amount_paid_cents) > 0) return fail("invoice_locked");
  if (inv.from_estimate === true) return fail("from_estimate");
  return { ok: true, removed: false };
}

// ---------------------------------------------------------------- finalize

/** The three snapshot columns: only a signature newer than the invoice's last change. */
function snapshotSet(s: Scope): SQL {
  if (s.rid !== null) {
    const fresh = sql.raw("CASE WHEN r.signed_at >= invoices.updated_at");
    return sql`signature_url = ${fresh} THEN r.signature_url END, signature_name = ${fresh} THEN r.signature_name END,
      signed_at = ${fresh} THEN r.signed_at END`;
  }
  // Request-less draft (admin only): scalar subqueries, so the UPDATE needs no join.
  const pick = (col: string) => sql`(SELECT r.${sql.raw(col)} FROM service_requests r
    WHERE r.id = invoices.service_request_id AND r.organization_id = ${s.org}::uuid AND r.signed_at >= invoices.updated_at)`;
  return sql`signature_url = ${pick("signature_url")}, signature_name = ${pick("signature_name")}, signed_at = ${pick("signed_at")}`;
}

export async function finalizeInvoice(
  actor: Actor, invoiceId: string,
): Promise<{ ok: true; state: string; changed: boolean } | Fail> {
  const scope = await resolveScope(actor, invoiceId);
  if ("ok" in scope) return scope;
  const { org } = scope;
  const join = scope.rid !== null
    ? sql`FROM service_requests r WHERE r.id = invoices.service_request_id AND r.organization_id = ${org}::uuid AND`
    : sql`WHERE`;
  const rows = await runBatch([
    ...locks(scope, invoiceId),
    sql`UPDATE invoices SET state = 'open'::invoice_state, issued_at = now(), ${snapshotSet(scope)}, updated_at = now()
      ${join} invoices.id = ${invoiceId}::uuid AND invoices.organization_id = ${org}::uuid AND ${scope.ridPred("invoices.service_request_id")}
        AND invoices.state = 'draft'::invoice_state AND invoices.fieldpulse_invoice_id IS NULL AND invoices.hcp_invoice_id IS NULL
        AND (${leadOrAdmin(scope)})
        AND EXISTS (SELECT 1 FROM invoice_line_items WHERE invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid)
      RETURNING invoices.state`,
    sql`SELECT state, (SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid) AS lines
      FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${scope.ridPred("service_request_id")}`,
    ...leadTail(scope),
  ]);
  if (!Array.isArray(rows)) return rows;
  const at = writeAt(scope);
  if (rows[at]!.length > 0) return { ok: true, state: "open", changed: true };
  if (!stillLead(scope, rows)) return fail("not_lead");
  const inv = rows[at + 1]![0];
  if (!inv) return fail("invoice_not_found");
  const state = inv.state as string;
  if (state === "open" || state === "paid" || state === "refunded") return { ok: true, state, changed: false };
  if (state === "void") return fail("invoice_locked");
  if (Number(inv.lines) === 0) return fail("no_lines");
  return fail("stale");
}

// ---------------------------------------------------------------- bill a sold estimate (M3c §5.3)

export type BillReason =
  | "estimate_not_found" | "estimate_not_sold" | "managed_externally" | "no_lines" | "already_billed"
  | "invoice_locked" | "invoice_changed" | "not_lead" | "stale" | "too_large";
export type BillResult =
  | { ok: true; invoiceId: string; added: number; hasMaterials: boolean }
  | { ok: false; reason: BillReason; invoiceId?: string };

const INT32_MAX = 2_147_483_647;
const BILL_IN = statusInSql(BILL_STATUSES);

/** subtotal + its tax would not fit an int4 money column. */
export function exceedsInt32(subtotalCents: number, taxBps: number): boolean {
  return subtotalCents + Math.round((subtotalCents * taxBps) / 10000) > INT32_MAX;
}

/** SQLSTATE 22003 (numeric value out of range) anywhere in the cause chain. */
export function isNumericOverflow(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e != null && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === "22003") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

type DraftResult = Awaited<ReturnType<typeof createInvoiceFromJob>>;

/**
 * Step 2: what the bill does with createInvoiceFromJob's answer. The caller
 * re-checks billed(eid) before returning any non-continue reason.
 * paid / refunded / invoice_voided describe THIS key's derived invoice, which
 * the same key always derives again: they map to the STORED invoice_changed so
 * the client mints a new key (plan ruling 11, a spec deviation). A plain stale
 * (a deadlock included) stays unstored.
 */
export function draftOutcome(r: DraftResult, hasPayment: boolean): "continue" | BillReason {
  if (r.ok) {
    if (r.state === "draft") return hasPayment ? "invoice_locked" : "continue";
    if (r.state === "open") return "invoice_locked";
    return "invoice_changed"; // paid / refunded
  }
  if (r.reason === "not_lead") return "not_lead";
  if (r.reason === "external_invoice" || r.reason === "managed_externally") return "managed_externally";
  if (r.reason === "invoice_voided") return "invoice_changed";
  return "stale";
}

/** Step 4: the batch's answer. */
export function billOutcome(t: {
  inserted: number; stillLead: boolean; state: string | null; hasPayment: boolean; billed: boolean;
}): "added" | BillReason {
  if (t.inserted > 0) return "added";
  if (t.billed) return "already_billed";
  if (!t.stillLead) return "not_lead";
  if ((t.state === "draft" && t.hasPayment) || t.state === "open") return "invoice_locked";
  return "stale";
}

/**
 * Step 3's guarded INSERT: the sold option's lines onto THIS draft, only while
 * it is a native unpaid draft of the request, the caller is still lead, the
 * request may be billed, the estimate is sold and native, and NOT billed(eid).
 * Exported so the integration suite can prove the in-batch guard on its own.
 */
export function billLinesSql(p: {
  org: string; rid: string; me: string; inv: string; estimateId: string;
  lines: readonly { readonly id: string; readonly eli: string }[];
}): SQL {
  const { org, rid, inv, estimateId } = p;
  const values = sql.join(p.lines.map((l) => sql`(${l.id}::uuid, ${l.eli}::uuid)`), sql`, `);
  return sql`INSERT INTO invoice_line_items (id, organization_id, invoice_id, estimate_line_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
    SELECT v.id, ${org}::uuid, ${inv}::uuid, el.id, el.name, el.quantity, el.unit_price_cents, el.cost_cents, el.line_total_cents
    FROM (VALUES ${values}) AS v(id, eli) JOIN estimate_line_items el ON el.id = v.eli AND el.organization_id = ${org}::uuid
    WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${inv}::uuid AND i.organization_id = ${org}::uuid AND i.service_request_id = ${rid}::uuid
        AND i.state = 'draft'::invoice_state AND i.amount_paid_cents = 0 AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL)
      AND (${stillLeadSql(org, rid, p.me)})
      AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.status IN ${BILL_IN})
      AND EXISTS (SELECT 1 FROM estimates se WHERE se.id = ${estimateId}::uuid AND se.organization_id = ${org}::uuid AND se.service_request_id = ${rid}::uuid
        AND se.status = 'sold'::estimate_status AND se.fieldpulse_estimate_id IS NULL AND se.sold_option_id = el.option_id)
      AND NOT ${billedSql(org, eidParam(estimateId))}
    ON CONFLICT (id) DO NOTHING RETURNING id`;
}

const alreadyBilled = (invoiceId: unknown): BillResult =>
  invoiceId ? { ok: false, reason: "already_billed", invoiceId: String(invoiceId) } : { ok: false, reason: "already_billed" };

async function billedNow(org: string, estimateId: string): Promise<{ billed: boolean; invoiceId: unknown }> {
  const eid = eidParam(estimateId);
  const [row] = await readRows(sql`SELECT ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS invoice_id`);
  return { billed: row?.billed === true, invoiceId: row?.invoice_id ?? null };
}

/**
 * Int4 headroom before drafting: an existing native draft is adopted as is;
 * an open native invoice seeds nothing (step 2 answers INVOICE_LOCKED); with
 * neither, step 2 creates a draft seeded with the job's unbilled materials.
 */
function headroomSql(org: string, rid: string): SQL {
  return sql`SELECT
      EXISTS (SELECT 1 FROM invoices d WHERE d.organization_id = ${org}::uuid AND d.service_request_id = ${rid}::uuid
        AND d.state = 'draft'::invoice_state AND d.fieldpulse_invoice_id IS NULL AND d.hcp_invoice_id IS NULL) AS draft_exists,
      EXISTS (SELECT 1 FROM invoices o WHERE o.organization_id = ${org}::uuid AND o.service_request_id = ${rid}::uuid
        AND o.state = 'open'::invoice_state AND o.fieldpulse_invoice_id IS NULL AND o.hcp_invoice_id IS NULL) AS open_exists,
      (SELECT COALESCE(SUM(l.line_total_cents), 0)::bigint FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id
        WHERE i.organization_id = ${org}::uuid AND l.organization_id = ${org}::uuid AND i.service_request_id = ${rid}::uuid
          AND i.state = 'draft'::invoice_state AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL) AS draft_sub,
      (SELECT COALESCE(SUM(m.quantity::bigint * m.unit_price_cents), 0)::bigint FROM job_materials m
        WHERE m.service_request_id = ${rid}::uuid AND m.organization_id = ${org}::uuid
          AND NOT ${materialBilledSql(org, rid, sql.raw("m.id"))}) AS materials_sub`;
}

/**
 * Put a sold estimate's option lines on the job's invoice, exactly once per
 * estimate (spec §5.3): pre-check → adopt-or-create the draft (M3b) → one
 * batch L_req → L_inv → billLinesSql (NOT billed(eid)) → totals → tails.
 */
export async function billSoldEstimate(
  actor: Actor & { requestId: string; techUserId: string },
  estimateId: string,
  ids: { invoiceId: string },
): Promise<BillResult> {
  const { organizationId: org, techUserId: me } = actor;
  const rid = actor.requestId.toLowerCase();
  const eid = eidParam(estimateId);

  // 1. Pre-check: no invoice is touched or created on a refusal.
  const [est] = await readRows(sql`SELECT e.status::text AS status, e.service_request_id,
      e.fieldpulse_estimate_id IS NOT NULL AS synced,
      ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS billed_invoice_id
    FROM estimates e WHERE e.id = ${estimateId}::uuid AND e.organization_id = ${org}::uuid`);
  if (!est || String(est.service_request_id) !== rid) return { ok: false, reason: "estimate_not_found" };
  if (est.status !== "sold") return { ok: false, reason: "estimate_not_sold" };
  if (est.synced === true) return { ok: false, reason: "managed_externally" };
  const lines = await readRows(sql`SELECT el.id, el.line_total_cents FROM estimate_line_items el
      JOIN estimates e ON e.sold_option_id = el.option_id
    WHERE e.id = ${estimateId}::uuid AND e.organization_id = ${org}::uuid AND el.organization_id = ${org}::uuid
    ORDER BY el.id`);
  if (lines.length === 0) return { ok: false, reason: "no_lines" };
  if (est.billed === true) return alreadyBilled(est.billed_invoice_id);

  const taxBps = await getDefaultTaxBps(org);
  const [room] = await readRows(headroomSql(org, rid));
  const existing = room?.draft_exists === true ? Number(room.draft_sub ?? 0)
    : room?.open_exists === true ? 0 : Number(room?.materials_sub ?? 0);
  const sale = lines.reduce((s, l) => s + Number(l.line_total_cents), 0);
  if (exceedsInt32(sale + existing, taxBps)) return { ok: false, reason: "too_large" };

  // 2. Draft: the normal M3b adopt-or-create (seeds the job's unbilled materials).
  let created: DraftResult;
  try {
    created = await createInvoiceFromJob({ ...actor, requestId: rid }, { invoiceId: ids.invoiceId });
  } catch (error) {
    if (isNumericOverflow(error)) return { ok: false, reason: "too_large" };
    throw error;
  }
  let hasPayment = false;
  if (created.ok && created.state === "draft") {
    const [row] = await readRows(sql`SELECT amount_paid_cents FROM invoices WHERE id = ${created.invoiceId}::uuid AND organization_id = ${org}::uuid`);
    hasPayment = Number(row?.amount_paid_cents ?? 0) > 0;
  }
  const step = draftOutcome(created, hasPayment);
  if (step !== "continue" || !created.ok) {
    const again = await billedNow(org, estimateId);
    if (again.billed) return alreadyBilled(again.invoiceId);
    return { ok: false, reason: step === "continue" ? "stale" : step };
  }
  const inv = created.invoiceId;

  // 3. One batch. Line ids are v7 in the estimate's line order; exactly-once is
  // NOT billed(eid) under L_req, not the ids.
  const lead = stillLeadSql(org, rid, me);
  let rows: Row[][] | Fail;
  try {
    rows = await runBatch([
      lockRequestSql(org, rid),
      lockInvoiceSql(org, inv),
      billLinesSql({ org, rid, me, inv, estimateId, lines: lines.map((l) => ({ id: uuidv7(), eli: String(l.id) })) }),
      totalsSql(org, inv, taxBps, LINE_GATE),
      sql`SELECT i.state::text AS state, i.amount_paid_cents,
          ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS billed_invoice_id,
          EXISTS (SELECT 1 FROM invoice_line_items m WHERE m.invoice_id = i.id AND m.organization_id = ${org}::uuid AND m.job_material_id IS NOT NULL) AS has_materials
        FROM invoices i WHERE i.id = ${inv}::uuid AND i.organization_id = ${org}::uuid`,
      sql`SELECT (${lead}) AS still_lead`,
    ]);
  } catch (error) {
    if (isNumericOverflow(error)) return { ok: false, reason: "too_large" };
    throw error;
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "stale" };

  // 4. Result.
  const inserted = rows[2]!.length;
  const tail = rows[4]![0];
  const outcome = billOutcome({
    inserted,
    stillLead: rows[5]![0]?.still_lead === true,
    state: tail ? String(tail.state) : null,
    hasPayment: Number(tail?.amount_paid_cents ?? 0) > 0,
    billed: tail?.billed === true,
  });
  if (outcome === "added") return { ok: true, invoiceId: inv, added: inserted, hasMaterials: tail?.has_materials === true };
  if (outcome === "already_billed") return alreadyBilled(tail?.billed_invoice_id);
  return { ok: false, reason: outcome };
}
