/**
 * Go-live marking (P6): pure SQL builders that mark an org's pre-go-live
 * history `hidden_from_org = true` (migration 0059) and undo it. Nothing here
 * deletes a row. Every table reference binds organization_id as a parameter and
 * every enum literal is cast.
 *
 * Two modes:
 * - "history" keeps live work: open requests, visits from today, open AR
 *   (ruling 10), open estimates, and resumable conversations (ruling 16).
 * - "empty" keeps only visits from today and resumable conversations.
 * Customers of anything kept stay visible in both.
 *
 * The kept sets read data columns only, never `hidden_from_org`, so the five
 * UPDATEs give the same result in any order. They SET only `hidden_from_org`,
 * which fires none of 0059's un-hide triggers (those are UPDATE OF
 * customer_id / service_request_id, or INSERT).
 */
import { sql, type SQL } from "drizzle-orm";
import { BUSINESS_TIME_ZONE } from "./calendar-time";

export type MarkingMode = "history" | "empty";

export const MARKING_MODES: readonly MarkingMode[] = ["history", "empty"];

/** The five tables 0059 gave `hidden_from_org`, children first. */
export const MARKED_TABLES = [
  "invoices",
  "estimates",
  "service_requests",
  "customer_sessions",
  "customers",
] as const;

export type MarkedTable = (typeof MARKED_TABLES)[number];

const NONE = (): SQL => sql.raw("SELECT NULL::uuid WHERE false");

const RESUMABLE_SESSIONS = (): SQL =>
  sql.raw("'chatting'::session_status, 'extracting'::session_status, 'confirmed'::session_status");

const TERMINAL_REQUESTS = (): SQL => sql.raw("'completed'::request_status, 'cancelled'::request_status");

/** Ruling 10: open, or a native draft (not FieldPulse, not HCP). */
const invoiceKeptWhere = (a: string): SQL =>
  sql.raw(
    `(${a}.state = 'open'::invoice_state OR (${a}.state = 'draft'::invoice_state AND ${a}.fieldpulse_invoice_id IS NULL AND ${a}.hcp_invoice_id IS NULL))`,
  );

const estimateKeptWhere = (a: string): SQL => sql.raw(`${a}.status = 'open'::estimate_status`);

/** Local midnight today in the org's timezone (after_hours_config), else the business timezone. */
export function todayStartSql(org: string): SQL {
  const tz = sql`COALESCE((SELECT NULLIF(os.after_hours_config->>'timezone', '') FROM organization_settings os WHERE os.organization_id = ${org}::uuid), ${BUSINESS_TIME_ZONE})`;
  return sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
}

/**
 * The request (correlated alias `sr`) has a visit from today on: its own
 * scheduled_date, or a live (not cancelled) appointment.
 */
export function visitFromTodaySql(org: string): SQL {
  return sql`(sr.scheduled_date >= ${todayStartSql(org)} OR EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = ${org}::uuid AND a.service_request_id = sr.id AND a.cancelled_at IS NULL AND COALESCE(a.starts_at, a.scheduled_date) >= ${todayStartSql(org)}))`;
}

export function keptRequestIdsSql(org: string, mode: MarkingMode): SQL {
  if (mode === "empty") {
    return sql`SELECT sr.id FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND ${visitFromTodaySql(org)}`;
  }
  return sql`SELECT sr.id FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND (sr.status NOT IN (${TERMINAL_REQUESTS()}) OR ${visitFromTodaySql(org)} OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = ${org}::uuid AND i.service_request_id = sr.id AND ${invoiceKeptWhere("i")}) OR EXISTS (SELECT 1 FROM estimates e WHERE e.organization_id = ${org}::uuid AND e.service_request_id = sr.id AND ${estimateKeptWhere("e")}))`;
}

export function keptInvoiceIdsSql(org: string, mode: MarkingMode): SQL {
  if (mode === "empty") return NONE();
  return sql`SELECT i.id FROM invoices i WHERE i.organization_id = ${org}::uuid AND ${invoiceKeptWhere("i")}`;
}

export function keptEstimateIdsSql(org: string, mode: MarkingMode): SQL {
  if (mode === "empty") return NONE();
  return sql`SELECT e.id FROM estimates e WHERE e.organization_id = ${org}::uuid AND ${estimateKeptWhere("e")}`;
}

/** Sessions of kept requests, plus every resumable session (ruling 16, both modes). */
export function keptSessionIdsSql(org: string, mode: MarkingMode): SQL {
  return sql`SELECT cs.id FROM customer_sessions cs WHERE cs.organization_id = ${org}::uuid AND (cs.status IN (${RESUMABLE_SESSIONS()}) OR cs.id IN (SELECT kr.session_id FROM service_requests kr WHERE kr.organization_id = ${org}::uuid AND kr.id IN (${keptRequestIdsSql(org, mode)})))`;
}

/**
 * Customers of kept requests, invoices, estimates and sessions. Returns
 * customer primary keys: the outer `id NOT IN (…)` would match nothing if this
 * list could hold a NULL customer_id.
 */
export function keptCustomerIdsSql(org: string, mode: MarkingMode): SQL {
  return sql`SELECT c.id FROM customers c WHERE c.organization_id = ${org}::uuid AND (c.id IN (SELECT kr.customer_id FROM service_requests kr WHERE kr.organization_id = ${org}::uuid AND kr.id IN (${keptRequestIdsSql(org, mode)})) OR c.id IN (SELECT ki.customer_id FROM invoices ki WHERE ki.organization_id = ${org}::uuid AND ki.id IN (${keptInvoiceIdsSql(org, mode)})) OR c.id IN (SELECT ke.customer_id FROM estimates ke WHERE ke.organization_id = ${org}::uuid AND ke.id IN (${keptEstimateIdsSql(org, mode)})) OR c.id IN (SELECT ks.customer_id FROM customer_sessions ks WHERE ks.organization_id = ${org}::uuid AND ks.id IN (${keptSessionIdsSql(org, mode)})))`;
}

function keptIdsSql(table: MarkedTable, org: string, mode: MarkingMode): SQL {
  switch (table) {
    case "invoices":
      return keptInvoiceIdsSql(org, mode);
    case "estimates":
      return keptEstimateIdsSql(org, mode);
    case "service_requests":
      return keptRequestIdsSql(org, mode);
    case "customer_sessions":
      return keptSessionIdsSql(org, mode);
    case "customers":
      return keptCustomerIdsSql(org, mode);
  }
}

/** Five UPDATEs, one per table, for a single db.batch. Already-hidden rows are left alone. */
export function markStatements(org: string, mode: MarkingMode): SQL[] {
  return MARKED_TABLES.map(
    (table) =>
      sql`UPDATE ${sql.raw(table)} SET hidden_from_org = true WHERE organization_id = ${org}::uuid AND NOT hidden_from_org AND id NOT IN (${keptIdsSql(table, org, mode)})`,
  );
}

/** Restores every hidden row of the org. */
export function unhideStatements(org: string): SQL[] {
  return MARKED_TABLES.map(
    (table) => sql`UPDATE ${sql.raw(table)} SET hidden_from_org = false WHERE organization_id = ${org}::uuid AND hidden_from_org`,
  );
}

function tableCountsSql(table: MarkedTable, org: string): SQL {
  const t = sql.raw(table);
  const wouldHide = (mode: MarkingMode) =>
    sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid AND NOT hidden_from_org AND id NOT IN (${keptIdsSql(table, org, mode)}))::int AS ${sql.raw(`${table}_hide_${mode}`)}`;
  return sql.join(
    [
      sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid)::int AS ${sql.raw(`${table}_total`)}`,
      sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid AND hidden_from_org)::int AS ${sql.raw(`${table}_hidden`)}`,
      wouldHide("history"),
      wouldHide("empty"),
    ],
    sql`, `,
  );
}

/**
 * One row. Per table: total, already hidden, and what each mode's apply would
 * newly hide. Plus open requests history keeps although they are over 60 days
 * old with no visit from today, and the open balance (cents) empty would hide.
 */
export function dryRunSql(org: string): SQL {
  const perTable = sql.join(
    MARKED_TABLES.map((table) => tableCountsSql(table, org)),
    sql`, `,
  );
  return sql`SELECT ${perTable}, (SELECT count(*) FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT sr.hidden_from_org AND sr.status NOT IN (${TERMINAL_REQUESTS()}) AND sr.created_at < now() - interval '60 days' AND NOT ${visitFromTodaySql(org)})::int AS old_open_requests_kept, (SELECT COALESCE(sum(GREATEST(oi.total_cents - oi.amount_paid_cents, 0)), 0) FROM invoices oi WHERE oi.organization_id = ${org}::uuid AND NOT oi.hidden_from_org AND oi.state = 'open'::invoice_state)::bigint AS open_ar_cents_hidden_in_empty`;
}
