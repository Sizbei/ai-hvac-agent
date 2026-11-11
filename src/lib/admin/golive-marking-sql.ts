/**
 * Go-live marking (P6): pure SQL builders that mark an org's pre-go-live
 * history `hidden_from_org = true` (migration 0059) and undo it. Nothing here
 * deletes a row. Every table reference binds organization_id as a parameter and
 * every enum literal is cast.
 *
 * Two modes:
 * - "history" keeps live work: requests not yet closed and created within the
 *   stale-days cut (default 60), visits from today, open AR (ruling 10), open
 *   estimates active in the last 90 days (FieldPulse rows by created_at, since
 *   the import rewrites updated_at) plus estimates a kept invoice references,
 *   and resumable conversations updated in the last 14 days (ruling 16,
 *   tightened at P8).
 * - "empty" keeps only visits from today and those recent resumable conversations.
 * - "seeded" hides ONLY the seeded rows below and keeps everything else (all
 *   imported history); kept = every non-seeded row. A customer is hidden only
 *   when it has a seeded link and no non-seeded link.
 * Every mode hides the seeded rows: HVAC-DEMO / HVAC-CAP requests, demo-seed- /
 * demo-cap- sessions, the sessions of seeded requests, and any invoice or
 * estimate on a seeded request.
 *
 * Kept sets build in one direction, no cycle: invoices → estimates → requests →
 * sessions → customers. Each later set keeps the parents of the earlier ones
 * (invoice → estimate, invoice/estimate → request, request → session, anything
 * → customer), so no visible child points at a hidden parent.
 *
 * The kept sets read data columns only, never `hidden_from_org`, so the five
 * UPDATEs give the same result in any order. They SET only `hidden_from_org`,
 * which fires none of the un-hide triggers (0059: UPDATE OF customer_id /
 * service_request_id, or INSERT; 0061: UPDATE OF status / scheduled_date /
 * state / an appointment's date).
 *
 * Once the org has a go-live cutoff (`feature_flags.historyCutoff`), every
 * UPDATE also skips rows created at or after it, so a --reapply never re-hides
 * post-go-live work.
 */
import { sql, type SQL } from "drizzle-orm";
import { BUSINESS_TIME_ZONE } from "./calendar-time";

export type MarkingMode = "history" | "empty" | "seeded";

/** The five tables 0059 gave `hidden_from_org`, children first. */
export const MARKED_TABLES = [
  "invoices",
  "estimates",
  "service_requests",
  "customer_sessions",
  "customers",
] as const;

export type MarkedTable = (typeof MARKED_TABLES)[number];

/** Default age (days) past which a request that is not closed and has no visit is hidden in history mode. */
export const DEFAULT_STALE_DAYS = 60;

const NONE = (): SQL => sql.raw("SELECT NULL::uuid WHERE false");

/** Requests the demo seed scripts created. reference_number is NOT NULL, so this is two-valued. */
const seededRef = (a: string): SQL =>
  sql.raw(`(${a}.reference_number LIKE 'HVAC-DEMO%' OR ${a}.reference_number LIKE 'HVAC-CAP%')`);

/** The invoice or estimate (alias `a`) is not on a seeded request. NOT EXISTS is two-valued for a NULL link. */
const notOnSeededRequest = (org: string, a: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM service_requests sd WHERE sd.organization_id = ${org}::uuid AND sd.id = ${sql.raw(`${a}.service_request_id`)} AND ${seededRef("sd")})`;

/** Session tokens the demo seed script writes (seed-demo.ts). token is NOT NULL. */
const seededToken = (a: string): SQL =>
  sql.raw(`(${a}.token LIKE 'demo-seed-%' OR ${a}.token LIKE 'demo-cap-%')`);

/** The session (alias `a`) is not seeded: neither a demo token nor a seeded request's session. */
const notSeededSession = (org: string, a: string): SQL =>
  sql`NOT ${seededToken(a)} AND NOT EXISTS (SELECT 1 FROM service_requests sd WHERE sd.organization_id = ${org}::uuid AND sd.session_id = ${sql.raw(`${a}.id`)} AND ${seededRef("sd")})`;

const RESUMABLE_SESSIONS = (): SQL =>
  sql.raw("'chatting'::session_status, 'extracting'::session_status, 'confirmed'::session_status");

const TERMINAL_REQUESTS = (): SQL => sql.raw("'completed'::request_status, 'cancelled'::request_status");

/** Ruling 10: open, or a native draft (not FieldPulse, not HCP). */
const invoiceKeptWhere = (a: string): SQL =>
  sql.raw(
    `(${a}.state = 'open'::invoice_state OR (${a}.state = 'draft'::invoice_state AND ${a}.fieldpulse_invoice_id IS NULL AND ${a}.hcp_invoice_id IS NULL))`,
  );

/**
 * When the estimate last saw real activity. The FieldPulse import rewrites
 * updated_at on every run, so FieldPulse rows use created_at. (No HCP estimate
 * mirror exists.)
 */
const estimateActivityAt = (a: string): string =>
  `(CASE WHEN ${a}.fieldpulse_estimate_id IS NOT NULL THEN ${a}.created_at ELSE COALESCE(${a}.updated_at, ${a}.created_at) END)`;

/** Open and active in the last 90 days (P8: FieldPulse never closes old estimates). */
const estimateKeptWhere = (a: string): SQL =>
  sql.raw(`(${a}.status = 'open'::estimate_status AND ${estimateActivityAt(a)} >= now() - interval '90 days')`);

/** Local midnight today in the org's timezone (after_hours_config), else the business timezone. */
export function todayStartSql(org: string): SQL {
  const tz = sql`COALESCE((SELECT NULLIF(os.after_hours_config->>'timezone', '') FROM organization_settings os WHERE os.organization_id = ${org}::uuid), ${BUSINESS_TIME_ZONE})`;
  return sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
}

/**
 * The request (correlated alias `sr`) has a visit from today on: its own
 * scheduled_date (unless the request is cancelled; its mirrored visit is), or a
 * live (not cancelled) appointment. Two-valued: a NULL scheduled_date is false,
 * not NULL, so `NOT <visit>` counts never-scheduled requests.
 */
export function visitFromTodaySql(org: string): SQL {
  return sql`COALESCE(((sr.status <> 'cancelled'::request_status AND sr.scheduled_date >= ${todayStartSql(org)}) OR EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = ${org}::uuid AND a.service_request_id = sr.id AND a.cancelled_at IS NULL AND COALESCE(a.starts_at, a.scheduled_date) >= ${todayStartSql(org)})), false)`;
}

/**
 * Never a seeded request. History: not closed and created within `staleDays`,
 * or a visit from today, or referenced by a kept invoice or estimate.
 */
export function keptRequestIdsSql(org: string, mode: MarkingMode, staleDays = DEFAULT_STALE_DAYS): SQL {
  if (mode === "seeded") {
    return sql`SELECT sr.id FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT ${seededRef("sr")}`;
  }
  if (mode === "empty") {
    return sql`SELECT sr.id FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT ${seededRef("sr")} AND ${visitFromTodaySql(org)}`;
  }
  return sql`SELECT sr.id FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT ${seededRef("sr")} AND ((sr.status NOT IN (${TERMINAL_REQUESTS()}) AND sr.created_at >= now() - make_interval(days => ${staleDays}::int)) OR ${visitFromTodaySql(org)} OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = ${org}::uuid AND i.service_request_id = sr.id AND ${invoiceKeptWhere("i")}) OR EXISTS (SELECT 1 FROM estimates re WHERE re.organization_id = ${org}::uuid AND re.service_request_id = sr.id AND re.id IN (${keptEstimateIdsSql(org, mode)})))`;
}

export function keptInvoiceIdsSql(org: string, mode: MarkingMode): SQL {
  if (mode === "empty") return NONE();
  if (mode === "seeded") {
    return sql`SELECT i.id FROM invoices i WHERE i.organization_id = ${org}::uuid AND ${notOnSeededRequest(org, "i")}`;
  }
  return sql`SELECT i.id FROM invoices i WHERE i.organization_id = ${org}::uuid AND ${invoiceKeptWhere("i")} AND ${notOnSeededRequest(org, "i")}`;
}

export function keptEstimateIdsSql(org: string, mode: MarkingMode): SQL {
  if (mode === "empty") return NONE();
  if (mode === "seeded") {
    return sql`SELECT e.id FROM estimates e WHERE e.organization_id = ${org}::uuid AND ${notOnSeededRequest(org, "e")}`;
  }
  return sql`SELECT e.id FROM estimates e WHERE e.organization_id = ${org}::uuid AND ${notOnSeededRequest(org, "e")} AND (${estimateKeptWhere("e")} OR e.id IN (SELECT ki.estimate_id FROM invoices ki WHERE ki.organization_id = ${org}::uuid AND ki.estimate_id IS NOT NULL AND ki.id IN (${keptInvoiceIdsSql(org, mode)})))`;
}

/**
 * Sessions of kept requests, plus resumable sessions (ruling 16, both modes)
 * updated in the last 14 days that are not seeded.
 */
export function keptSessionIdsSql(org: string, mode: MarkingMode, staleDays = DEFAULT_STALE_DAYS): SQL {
  if (mode === "seeded") {
    return sql`SELECT cs.id FROM customer_sessions cs WHERE cs.organization_id = ${org}::uuid AND ${notSeededSession(org, "cs")}`;
  }
  return sql`SELECT cs.id FROM customer_sessions cs WHERE cs.organization_id = ${org}::uuid AND ((cs.status IN (${RESUMABLE_SESSIONS()}) AND cs.updated_at >= now() - interval '14 days' AND ${notSeededSession(org, "cs")}) OR cs.id IN (SELECT kr.session_id FROM service_requests kr WHERE kr.organization_id = ${org}::uuid AND kr.id IN (${keptRequestIdsSql(org, mode, staleDays)})))`;
}

/**
 * Customers of kept requests, invoices, estimates and sessions. Returns
 * customer primary keys: the outer `id NOT IN (…)` would match nothing if this
 * list could hold a NULL customer_id.
 */
export function keptCustomerIdsSql(org: string, mode: MarkingMode, staleDays = DEFAULT_STALE_DAYS): SQL {
  if (mode === "seeded") {
    // Kept unless it has a seeded link and no kept (non-seeded) link.
    const seededLink = sql`(EXISTS (SELECT 1 FROM service_requests sx WHERE sx.organization_id = ${org}::uuid AND sx.customer_id = c.id AND ${seededRef("sx")}) OR EXISTS (SELECT 1 FROM invoices ix WHERE ix.organization_id = ${org}::uuid AND ix.customer_id = c.id AND NOT ${notOnSeededRequest(org, "ix")}) OR EXISTS (SELECT 1 FROM estimates ex WHERE ex.organization_id = ${org}::uuid AND ex.customer_id = c.id AND NOT ${notOnSeededRequest(org, "ex")}) OR EXISTS (SELECT 1 FROM customer_sessions sx2 WHERE sx2.organization_id = ${org}::uuid AND sx2.customer_id = c.id AND NOT ${notSeededSession(org, "sx2")}))`;
    return sql`SELECT c.id FROM customers c WHERE c.organization_id = ${org}::uuid AND (NOT ${seededLink} OR c.id IN (SELECT kr.customer_id FROM service_requests kr WHERE kr.organization_id = ${org}::uuid AND kr.id IN (${keptRequestIdsSql(org, mode)})) OR c.id IN (SELECT ki.customer_id FROM invoices ki WHERE ki.organization_id = ${org}::uuid AND ki.id IN (${keptInvoiceIdsSql(org, mode)})) OR c.id IN (SELECT ke.customer_id FROM estimates ke WHERE ke.organization_id = ${org}::uuid AND ke.id IN (${keptEstimateIdsSql(org, mode)})) OR c.id IN (SELECT ks.customer_id FROM customer_sessions ks WHERE ks.organization_id = ${org}::uuid AND ks.id IN (${keptSessionIdsSql(org, mode)})))`;
  }
  return sql`SELECT c.id FROM customers c WHERE c.organization_id = ${org}::uuid AND (c.id IN (SELECT kr.customer_id FROM service_requests kr WHERE kr.organization_id = ${org}::uuid AND kr.id IN (${keptRequestIdsSql(org, mode, staleDays)})) OR c.id IN (SELECT ki.customer_id FROM invoices ki WHERE ki.organization_id = ${org}::uuid AND ki.id IN (${keptInvoiceIdsSql(org, mode)})) OR c.id IN (SELECT ke.customer_id FROM estimates ke WHERE ke.organization_id = ${org}::uuid AND ke.id IN (${keptEstimateIdsSql(org, mode)})) OR c.id IN (SELECT ks.customer_id FROM customer_sessions ks WHERE ks.organization_id = ${org}::uuid AND ks.id IN (${keptSessionIdsSql(org, mode, staleDays)})))`;
}

function keptIdsSql(table: MarkedTable, org: string, mode: MarkingMode, staleDays: number): SQL {
  switch (table) {
    case "invoices":
      return keptInvoiceIdsSql(org, mode);
    case "estimates":
      return keptEstimateIdsSql(org, mode);
    case "service_requests":
      return keptRequestIdsSql(org, mode, staleDays);
    case "customer_sessions":
      return keptSessionIdsSql(org, mode, staleDays);
    case "customers":
      return keptCustomerIdsSql(org, mode, staleDays);
  }
}

/**
 * The row (unqualified: the UPDATE / count target) was created before the org's
 * go-live cutoff; always true when no cutoff is set. A malformed cutoff fails
 * the cast, so the statement errors rather than run unbounded.
 */
function beforeCutoffSql(org: string): SQL {
  return sql`created_at < COALESCE((SELECT (o.feature_flags->>'historyCutoff')::timestamptz FROM organizations o WHERE o.id = ${org}::uuid), 'infinity'::timestamptz)`;
}

/** Five UPDATEs, one per table, for a single db.batch. Already-hidden rows and rows from the cutoff on are left alone. */
export function markStatements(org: string, mode: MarkingMode, staleDays = DEFAULT_STALE_DAYS): SQL[] {
  return MARKED_TABLES.map(
    (table) =>
      sql`UPDATE ${sql.raw(table)} SET hidden_from_org = true WHERE organization_id = ${org}::uuid AND NOT hidden_from_org AND id NOT IN (${keptIdsSql(table, org, mode, staleDays)}) AND ${beforeCutoffSql(org)}`,
  );
}

/** Restores every hidden row of the org. */
export function unhideStatements(org: string): SQL[] {
  return MARKED_TABLES.map(
    (table) => sql`UPDATE ${sql.raw(table)} SET hidden_from_org = false WHERE organization_id = ${org}::uuid AND hidden_from_org`,
  );
}

/** The four tables --unhide-fieldpulse touches. Conversations keep their state: FieldPulse has none. */
export const FIELDPULSE_TABLES = ["invoices", "estimates", "service_requests", "customers"] as const;
export type FieldpulseTable = (typeof FIELDPULSE_TABLES)[number];

/**
 * The request (alias `a`) came in through the FieldPulse import: the importer
 * gives every job it creates a synthetic `fp-import-<job id>` session
 * (import/jobs.ts). A native request later pushed to FieldPulse also gets a
 * fieldpulse_job_id (job-sync.ts) but keeps its own chat, voice or admin
 * session, so the token is what tells them apart.
 */
function importedRequestSql(org: string, a: string): SQL {
  return sql`(${sql.raw(`${a}.fieldpulse_job_id`)} IS NOT NULL AND EXISTS (SELECT 1 FROM customer_sessions fs WHERE fs.organization_id = ${org}::uuid AND fs.id = ${sql.raw(`${a}.session_id`)} AND fs.token LIKE 'fp-import-%'))`;
}

/**
 * The customer (alias `a`) is FieldPulse-imported: it has imported work (an
 * imported request, or a FieldPulse invoice or estimate; those two are only
 * ever pulled, never pushed), or it has a FieldPulse id and no native request.
 * A native customer gets a FieldPulse id only when one of its native requests
 * is pushed (customer-sync.ts, called from job-sync.ts), so a FieldPulse id
 * next to native requests alone marks a native customer.
 */
function importedCustomerSql(org: string, a: string): SQL {
  const id = sql.raw(`${a}.id`);
  return sql`(EXISTS (SELECT 1 FROM service_requests fr WHERE fr.organization_id = ${org}::uuid AND fr.customer_id = ${id} AND ${importedRequestSql(org, "fr")}) OR EXISTS (SELECT 1 FROM invoices fi WHERE fi.organization_id = ${org}::uuid AND fi.customer_id = ${id} AND fi.fieldpulse_invoice_id IS NOT NULL) OR EXISTS (SELECT 1 FROM estimates fe WHERE fe.organization_id = ${org}::uuid AND fe.customer_id = ${id} AND fe.fieldpulse_estimate_id IS NOT NULL) OR (${sql.raw(`${a}.fieldpulse_customer_id`)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_requests nr WHERE nr.organization_id = ${org}::uuid AND nr.customer_id = ${id} AND NOT ${importedRequestSql(org, "nr")})))`;
}

/**
 * FieldPulse-IMPORTED rows of `table` (the UPDATE / count target, referenced by
 * its table name). Reads data columns only, never hidden_from_org, so the
 * UPDATEs give the same result in any order.
 */
export function fieldpulseImportedSql(table: FieldpulseTable, org: string): SQL {
  switch (table) {
    case "invoices":
      return sql.raw("invoices.fieldpulse_invoice_id IS NOT NULL");
    case "estimates":
      return sql.raw("estimates.fieldpulse_estimate_id IS NOT NULL");
    case "service_requests":
      return importedRequestSql(org, "service_requests");
    case "customers":
      return importedCustomerSql(org, "customers");
  }
}

/**
 * Native rows that carry FieldPulse links (requests pushed to FieldPulse and
 * their customers). --unhide-fieldpulse lists them for review and leaves them.
 */
function nativeFieldpulseSql(table: "service_requests" | "customers", org: string): SQL {
  if (table === "service_requests") {
    return sql`(service_requests.fieldpulse_job_id IS NOT NULL AND NOT ${importedRequestSql(org, "service_requests")})`;
  }
  return sql`(customers.fieldpulse_customer_id IS NOT NULL AND NOT ${importedCustomerSql(org, "customers")})`;
}

/** Row ids an --unhide-fieldpulse run must leave hidden (the fp-hide-deleted-jobs undo files). */
export interface FieldpulseKeepHidden {
  readonly invoices: readonly string[];
  readonly estimates: readonly string[];
  readonly service_requests: readonly string[];
}

const NO_KEEP: FieldpulseKeepHidden = { invoices: [], estimates: [], service_requests: [] };

function notKeptSql(table: FieldpulseTable, keep: FieldpulseKeepHidden): SQL {
  const ids = table === "customers" ? [] : keep[table];
  // One bound array literal; the ids were read back from undo files and are checked as uuids by the caller.
  return ids.length === 0 ? sql.raw("true") : sql`NOT (id = ANY(${`{${ids.join(",")}}`}::uuid[]))`;
}

/**
 * Restores only FieldPulse-IMPORTED history (four UPDATEs for one db.batch).
 * Conversations, native requests (demo-era traffic, seeded rows, requests
 * pushed to FieldPulse), their native customers, and the `keep` rows (requests
 * hidden because FieldPulse deleted the job) keep whatever state they have.
 * The history cutoff is not touched.
 */
export function unhideFieldpulseStatements(org: string, keep: FieldpulseKeepHidden = NO_KEEP): SQL[] {
  return FIELDPULSE_TABLES.map(
    (table) =>
      sql`UPDATE ${sql.raw(table)} SET hidden_from_org = false WHERE organization_id = ${org}::uuid AND hidden_from_org AND ${fieldpulseImportedSql(table, org)} AND ${notKeptSql(table, keep)}`,
  );
}

/**
 * One row: per table, the hidden imported rows --unhide-fieldpulse would
 * restore (`<table>_fp_hidden`) and the `keep` rows it leaves
 * (`<table>_fp_kept`); then the hidden native rows with FieldPulse links,
 * listed and left alone (`native_requests`: reference numbers,
 * `native_customers`: row ids).
 */
export function unhideFieldpulseDryRunSql(org: string, keep: FieldpulseKeepHidden = NO_KEEP): SQL {
  const cols = FIELDPULSE_TABLES.flatMap((table) => [
    sql`(SELECT count(*) FROM ${sql.raw(table)} WHERE organization_id = ${org}::uuid AND hidden_from_org AND ${fieldpulseImportedSql(table, org)} AND ${notKeptSql(table, keep)})::int AS ${sql.raw(`${table}_fp_hidden`)}`,
    sql`(SELECT count(*) FROM ${sql.raw(table)} WHERE organization_id = ${org}::uuid AND hidden_from_org AND ${fieldpulseImportedSql(table, org)} AND NOT ${notKeptSql(table, keep)})::int AS ${sql.raw(`${table}_fp_kept`)}`,
  ]);
  const natives = [
    sql`ARRAY(SELECT reference_number FROM service_requests WHERE organization_id = ${org}::uuid AND hidden_from_org AND ${nativeFieldpulseSql("service_requests", org)} ORDER BY reference_number)::text[] AS native_requests`,
    sql`ARRAY(SELECT id::text FROM customers WHERE organization_id = ${org}::uuid AND hidden_from_org AND ${nativeFieldpulseSql("customers", org)} ORDER BY id)::text[] AS native_customers`,
  ];
  return sql`SELECT ${sql.join([...cols, ...natives], sql`, `)}`;
}

/**
 * One row: per table, the VISIBLE imported FieldPulse rows a `mode` --apply
 * would hide (`<table>_fp_rehide`). The script refuses an --apply that would
 * re-hide FieldPulse history (rows the sync or backfill re-dated before the
 * cutoff included) unless the operator passes --hide-fieldpulse.
 */
export function fieldpulseRehideSql(org: string, mode: MarkingMode, staleDays = DEFAULT_STALE_DAYS): SQL {
  const cols = FIELDPULSE_TABLES.map(
    (table) =>
      sql`(SELECT count(*) FROM ${sql.raw(table)} WHERE organization_id = ${org}::uuid AND NOT hidden_from_org AND id NOT IN (${keptIdsSql(table, org, mode, staleDays)}) AND ${beforeCutoffSql(org)} AND ${fieldpulseImportedSql(table, org)})::int AS ${sql.raw(`${table}_fp_rehide`)}`,
  );
  return sql`SELECT ${sql.join(cols, sql`, `)}`;
}

function tableCountsSql(table: MarkedTable, org: string, staleDays: number): SQL {
  const t = sql.raw(table);
  const wouldHide = (mode: MarkingMode) =>
    sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid AND NOT hidden_from_org AND id NOT IN (${keptIdsSql(table, org, mode, staleDays)}) AND ${beforeCutoffSql(org)})::int AS ${sql.raw(`${table}_hide_${mode}`)}`;
  return sql.join(
    [
      sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid)::int AS ${sql.raw(`${table}_total`)}`,
      sql`(SELECT count(*) FROM ${t} WHERE organization_id = ${org}::uuid AND hidden_from_org)::int AS ${sql.raw(`${table}_hidden`)}`,
      wouldHide("history"),
      wouldHide("empty"),
      wouldHide("seeded"),
    ],
    sql`, `,
  );
}

/** Requests not yet closed, older than `staleDays`, with no visit from today (alias `sr`). */
function oldOpenRequestSql(org: string, staleDays: number): SQL {
  return sql`sr.status NOT IN (${TERMINAL_REQUESTS()}) AND sr.created_at < now() - make_interval(days => ${staleDays}::int) AND NOT ${visitFromTodaySql(org)}`;
}

/**
 * The per-rule counts, all of visible rows:
 * - stale_requests_hidden: old open requests (not seeded) that history hides;
 * - old_open_requests_kept: old open requests history keeps for a kept invoice or estimate;
 * - stale_estimates_hidden: open estimates inactive for 90 days that history hides;
 * - stale_sessions_hidden: resumable sessions idle for 14 days that history hides;
 * - seeded_requests_hidden: HVAC-DEMO / HVAC-CAP requests, hidden in both modes;
 * - seeded_sessions_hidden: demo-token sessions and seeded requests' sessions history hides.
 */
function ruleCountsSql(org: string, staleDays: number): SQL {
  const keptRequests = keptRequestIdsSql(org, "history", staleDays);
  return sql.join(
    [
      sql`(SELECT count(*) FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT sr.hidden_from_org AND NOT ${seededRef("sr")} AND ${oldOpenRequestSql(org, staleDays)} AND sr.id NOT IN (${keptRequests}))::int AS stale_requests_hidden`,
      sql`(SELECT count(*) FROM service_requests sr WHERE sr.organization_id = ${org}::uuid AND NOT sr.hidden_from_org AND ${oldOpenRequestSql(org, staleDays)} AND sr.id IN (${keptRequests}))::int AS old_open_requests_kept`,
      sql`(SELECT count(*) FROM estimates se WHERE se.organization_id = ${org}::uuid AND NOT se.hidden_from_org AND se.status = 'open'::estimate_status AND ${sql.raw(estimateActivityAt("se"))} < now() - interval '90 days' AND se.id NOT IN (${keptEstimateIdsSql(org, "history")}))::int AS stale_estimates_hidden`,
      sql`(SELECT count(*) FROM customer_sessions ss WHERE ss.organization_id = ${org}::uuid AND NOT ss.hidden_from_org AND ss.status IN (${RESUMABLE_SESSIONS()}) AND ss.updated_at < now() - interval '14 days' AND ss.id NOT IN (${keptSessionIdsSql(org, "history", staleDays)}))::int AS stale_sessions_hidden`,
      sql`(SELECT count(*) FROM service_requests sq WHERE sq.organization_id = ${org}::uuid AND NOT sq.hidden_from_org AND ${seededRef("sq")})::int AS seeded_requests_hidden`,
      sql`(SELECT count(*) FROM customer_sessions sz WHERE sz.organization_id = ${org}::uuid AND NOT sz.hidden_from_org AND NOT (${notSeededSession(org, "sz")}) AND sz.id NOT IN (${keptSessionIdsSql(org, "history", staleDays)}))::int AS seeded_sessions_hidden`,
    ],
    sql`, `,
  );
}

/**
 * One row. Per table: total, already hidden, and what each mode's apply would
 * newly hide. Then the per-rule counts (ruleCountsSql) and the open balance
 * (cents) empty would hide.
 */
export function dryRunSql(org: string, staleDays = DEFAULT_STALE_DAYS): SQL {
  const perTable = sql.join(
    MARKED_TABLES.map((table) => tableCountsSql(table, org, staleDays)),
    sql`, `,
  );
  return sql`SELECT ${perTable}, ${ruleCountsSql(org, staleDays)}, (SELECT COALESCE(sum(GREATEST(oi.total_cents - oi.amount_paid_cents, 0)), 0) FROM invoices oi WHERE oi.organization_id = ${org}::uuid AND NOT oi.hidden_from_org AND oi.state = 'open'::invoice_state)::bigint AS open_ar_cents_hidden_in_empty`;
}
