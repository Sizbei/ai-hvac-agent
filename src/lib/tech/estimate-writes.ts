/**
 * Field estimate writers (M3c spec §5.1, §5.2, §5.5). Each write is ONE
 * db.batch: L_req first, then the guarded statement, then tail SELECTs that
 * the pure *Outcome mappers read when the guarded statement matched 0 rows.
 */
import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
import { lockRequestSql, readRows, runBatch, stillLeadSql } from "@/lib/admin/invoice-field-writes";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";
import { buildFieldEstimate, type CreateEstimateInput, type PricedItem } from "@/lib/tech/estimate-input";

export interface EstimateActor { organizationId: string; requestId: string; techUserId: string }
export type EstimateWriteReason =
  | "estimate_not_found" | "no_customer" | "not_lead" | "not_on_site" | "job_closed" | "stale"
  | "already_decided" | "estimate_expired" | "invalid_option" | "item_inactive" | "too_large" | "managed_externally";
export type EstimateWriteResult =
  | { ok: true; estimateId: string; created: boolean }
  | { ok: false; reason: EstimateWriteReason };

type Row = Record<string, unknown>;
const fail = (reason: EstimateWriteReason): EstimateWriteResult => ({ ok: false, reason });
const SELL_IN = statusInSql(SELL_STATUSES);
const lower = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).toLowerCase());

/** The request's status as a refusal, or null when it allows selling. */
function statusReason(status: unknown): EstimateWriteReason | null {
  if (typeof status !== "string") return "stale";
  const gate = statusGate(status, SELL_STATUSES);
  return gate === "ok" ? null : gate;
}

// ---------------------------------------------------------------- create

export function createOutcome(tail: Row | undefined, eid: string): EstimateWriteResult {
  if (!tail) return fail("stale");
  if (tail.exists === true) return { ok: true, estimateId: eid, created: false };
  if (tail.still_lead !== true) return fail("not_lead");
  const s = statusReason(tail.status);
  if (s) return fail(s);
  if (tail.customer_id === null || tail.customer_id === undefined) return fail("no_customer");
  return fail("stale"); // a different customer now, or nothing visible changed
}

export async function createFieldEstimate(
  actor: EstimateActor, ids: { estimateId: string }, input: CreateEstimateInput,
): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const eid = ids.estimateId;
  const [req] = await readRows(sql`SELECT customer_id FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return fail("stale"); // unreachable behind the preamble; never the estimate 404 copy (plan ruling 16)
  const cust = (req.customer_id as string | null) ?? null;
  if (cust === null) return fail("no_customer");

  const itemIds = [...new Set(input.options.flatMap((o) => o.lines.map((l) => l.pricebookItemId.toLowerCase())))];
  const itemRows = await readRows(sql`SELECT id, name, price_cents, cost_cents FROM pricebook_items
    WHERE organization_id = ${org}::uuid AND active AND id IN (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
  const items = new Map<string, PricedItem>(itemRows.map((r) => [String(r.id), {
    id: String(r.id), name: String(r.name), priceCents: Number(r.price_cents), costCents: Number(r.cost_cents),
  }]));
  const built = buildFieldEstimate(input, items, await getDefaultTaxBps(org), uuidv7);
  if (!built.ok) return fail(built.reason);

  const lead = stillLeadSql(org, rid, me);
  const mine = sql`EXISTS (SELECT 1 FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND xmin = pg_current_xact_id()::xid)`;
  const optionValues = sql.join(built.options.map((o) =>
    sql`(${o.id}::uuid, ${o.name}::text, ${o.sortOrder}::int, ${o.subtotalCents}::int, ${o.taxCents}::int, ${o.totalCents}::int)`), sql`, `);
  const lineValues = sql.join(built.lines.map((l) =>
    sql`(${l.id}::uuid, ${l.optionId}::uuid, ${l.pricebookItemId}::uuid, ${l.name}::text, ${l.quantity}::int, ${l.unitPriceCents}::int, ${l.costCents}::int, ${l.lineTotalCents}::int)`), sql`, `);

  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`INSERT INTO estimates (id, organization_id, service_request_id, customer_id, status, total_cents, expires_at, title, approval_token_hash)
      SELECT ${eid}::uuid, ${org}::uuid, ${rid}::uuid, ${cust}::uuid, 'open'::estimate_status, ${built.totalCents}::int,
        now() + interval '30 days', 'Field estimate', NULL
      WHERE (${lead}) AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
        AND r.status IN ${SELL_IN} AND r.customer_id = ${cust}::uuid)
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    sql`INSERT INTO estimate_options (id, organization_id, estimate_id, name, sort_order, subtotal_cents, tax_cents, total_cents)
      SELECT v.id, ${org}::uuid, ${eid}::uuid, v.name, v.sort_order, v.subtotal_cents, v.tax_cents, v.total_cents
      FROM (VALUES ${optionValues}) AS v(id, name, sort_order, subtotal_cents, tax_cents, total_cents) WHERE ${mine}`,
    sql`INSERT INTO estimate_line_items (id, organization_id, option_id, pricebook_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      SELECT v.id, ${org}::uuid, v.option_id, v.pricebook_item_id, v.name, v.quantity, v.unit_price_cents, v.cost_cents, v.line_total_cents
      FROM (VALUES ${lineValues}) AS v(id, option_id, pricebook_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents) WHERE ${mine}`,
    sql`SELECT (${lead}) AS still_lead, r.status::text AS status, r.customer_id,
        EXISTS (SELECT 1 FROM estimates e WHERE e.id = ${eid}::uuid AND e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid) AS exists
      FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[1]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return createOutcome(rows[4]![0], eid);
}

// ---------------------------------------------------------------- sell

export function sellOutcome(
  est: Row | undefined, tail: Row | undefined, ctx: { rid: string; me: string; opt: string; eid: string },
): EstimateWriteResult {
  if (!est || lower(est.service_request_id) !== ctx.rid.toLowerCase()) return fail("estimate_not_found");
  if (est.synced === true) return fail("managed_externally");
  if (est.status === "sold" && lower(est.sold_option_id) === ctx.opt.toLowerCase()
    && est.sold_via === "field" && lower(est.sold_by) === ctx.me.toLowerCase()) {
    return { ok: true, estimateId: ctx.eid, created: false };
  }
  if (est.status === "expired" || (est.status === "open" && est.past_expiry === true)) return fail("estimate_expired");
  if (est.status !== "open") return fail("already_decided");
  if (est.option_ok !== true) return fail("invalid_option");
  if (tail?.still_lead !== true) return fail("not_lead");
  return fail(statusReason(tail.request_status) ?? "stale");
}

export async function sellFieldEstimate(
  actor: EstimateActor, input: { estimateId: string; optionId: string; signatureName: string },
): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const { estimateId: eid, optionId: opt } = input;
  const lead = stillLeadSql(org, rid, me);
  const optionOk = sql`EXISTS (SELECT 1 FROM estimate_options o WHERE o.id = ${opt}::uuid AND o.estimate_id = ${eid}::uuid AND o.organization_id = ${org}::uuid)`;
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`SELECT 1 FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`,
    sql`UPDATE estimates SET status = 'sold'::estimate_status, sold_option_id = ${opt}::uuid, signed_at = now(), signature_name = ${input.signatureName.trim()}, signature_ip = NULL, sold_via = 'field', sold_by = ${me}::uuid, updated_at = now()
      WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL OR expires_at > now())
        AND ${optionOk} AND (${lead})
        AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.status IN ${SELL_IN})
      RETURNING id`,
    sql`SELECT status::text AS status, service_request_id, sold_option_id, sold_via, sold_by,
        fieldpulse_estimate_id IS NOT NULL AS synced, (expires_at IS NOT NULL AND expires_at <= now()) AS past_expiry, ${optionOk} AS option_ok
      FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid`,
    sql`SELECT (${lead}) AS still_lead,
        (SELECT status::text FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid) AS request_status`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[2]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return sellOutcome(rows[3]![0], rows[4]![0], { rid, me, opt, eid });
}

// ---------------------------------------------------------------- decline

export function declineOutcome(est: Row | undefined, tail: Row | undefined, ctx: { rid: string; eid: string }): EstimateWriteResult {
  if (!est || lower(est.service_request_id) !== ctx.rid.toLowerCase()) return fail("estimate_not_found");
  if (est.synced === true) return fail("managed_externally");
  if (est.status === "dismissed") return { ok: true, estimateId: ctx.eid, created: false };
  if (est.status !== "open") return fail("already_decided");
  if (tail?.still_lead !== true) return fail("not_lead");
  return fail("stale");
}

export async function declineFieldEstimate(actor: EstimateActor, estimateId: string): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const eid = estimateId;
  const lead = stillLeadSql(org, rid, me);
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`UPDATE estimates SET status = 'dismissed'::estimate_status, updated_at = now()
      WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (${lead})
      RETURNING id`,
    sql`SELECT status::text AS status, service_request_id, fieldpulse_estimate_id IS NOT NULL AS synced
      FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid`,
    sql`SELECT (${lead}) AS still_lead`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[1]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return declineOutcome(rows[2]![0], rows[3]![0], { rid, eid });
}
