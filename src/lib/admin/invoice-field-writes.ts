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
import { db } from "@/lib/db";
import { getDefaultTaxBps, getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { materialLineId } from "@/lib/http/idempotency";
import { isDeadlock } from "@/lib/tech/status-writes";
import { SIGNABLE_IN } from "@/lib/tech/field-queries";

export type FieldReason =
  | "managed_externally" | "external_invoice" | "not_lead" | "invoice_not_found" | "invoice_voided"
  | "invoice_locked" | "no_lines" | "already_billed" | "item_not_found" | "invoice_not_chargeable"
  | "exceeds_balance" | "synced_read_only" | "payment_id_conflict" | "refund_id_conflict" | "stale";

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
      AND (${leadOrAdmin(scope)}) AND ${draftInvoiceExists(scope, invoiceId, sql` AND i.amount_paid_cents = 0`)} RETURNING id`,
    totalsSql(org, invoiceId, await getDefaultTaxBps(org), LINE_GATE),
    sql`SELECT state, amount_paid_cents FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${scope.ridPred("service_request_id")}`,
    ...leadTail(scope),
  ]);
  if (!Array.isArray(rows)) return rows;
  const at = writeAt(scope);
  if (rows[at]!.length > 0) return { ok: true, removed: true };
  if (!stillLead(scope, rows)) return fail("not_lead");
  const inv = rows[at + 2]![0];
  if (!inv) return fail("invoice_not_found");
  if (inv.state !== "draft" || Number(inv.amount_paid_cents) > 0) return fail("invoice_locked");
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
