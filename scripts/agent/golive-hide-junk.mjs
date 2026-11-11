#!/usr/bin/env node
/**
 * Go-live junk cleanup: hide the test and placeholder rows staff made while
 * trying out FieldPulse, and the pre-go-live chatbot demo traffic, from the
 * org's own view. Reversible, never a DELETE, and nothing is written to
 * FieldPulse. The platform owner still sees them.
 *
 *   npx tsx scripts/agent/golive-hide-junk.mjs --org <uuid>            # dry run
 *   npx tsx scripts/agent/golive-hide-junk.mjs --org <uuid> --apply    # hide, writes the undo record
 *   npx tsx scripts/agent/golive-hide-junk.mjs --org <uuid> --undo <record>            # dry run of the undo
 *   npx tsx scripts/agent/golive-hide-junk.mjs --org <uuid> --undo <record> --apply    # show again
 *   add --list <file> to use another list (default scripts/agent/golive-junk-list.json)
 *
 * What changes: `hidden_from_org = true` on listed requests, customers,
 * invoices and estimates, plus the unsynced or $0 invoices/estimates and the
 * conversations of listed requests; `active = false` on listed
 * pricebook items. --apply first writes an undo record to
 * ~/.hvac-golive/golive-junk-<host>-<org>-<time>.json with exactly the rows it
 * changes (rows still visible / items still active); --undo <record> --apply
 * puts back exactly those rows, never one something else had hidden or
 * deactivated. The safety rules (real
 * paid money never hidden; a customer only when all its work goes) live in
 * src/lib/admin/golive-junk.ts.
 *
 * Order on prod: run AFTER golive-hide-history.mjs. Its --unhide un-hides these
 * rows too, and its --apply refuses while any row is hidden, so re-run this
 * --apply after either. Setting only hidden_from_org / active fires none of the
 * 0059/0061 un-hide triggers.
 *
 * Any run against the production host (ep-withered-hill, any letter case)
 * needs --prod; only the user passes it, never an agent.
 * DATABASE_URL comes from the environment, else (not with --prod) from
 * .env.local (scripts/agent/golive-env.mjs).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { goliveRecordPath, loadGoliveEnv } from "./golive-env.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIST = "scripts/agent/golive-junk-list.json";

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, list: DEFAULT_LIST, apply: false, undo: null, prod: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--list" || arg === "--undo") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--apply" || arg === "--prod") {
      out[arg.slice(2)] = true;
    } else {
      refuse(`unknown argument ${arg}`);
    }
  }
  if (!out.org || !UUID.test(out.org)) refuse("--org must be an organization uuid");
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Before any connection: the database modules are imported only past this line.
const url = loadGoliveEnv({ prod: args.prod, keys: ["DATABASE_URL"] });
const host = new URL(url).hostname.split(".")[0].toLowerCase();

const { parseJunkList, planJunk } = await import("../../src/lib/admin/golive-junk.ts");
let list;
try {
  list = parseJunkList(JSON.parse(readFileSync(args.list, "utf8")));
} catch (err) {
  refuse(`cannot read ${args.list}: ${err instanceof Error ? err.message : String(err)}`);
}

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { sql } = await import("drizzle-orm");
const db = drizzle(neon(url));
// One bound parameter per array (drizzle would expand a JS array into a row). Values are
// validated list keys or uuids read back from the database, so the literal needs no quoting.
const pgArray = (values) => `{${values.join(",")}}`;
const rows = async (statement) => (await db.execute(statement)).rows;
const org = args.org;

const orgRow = (await rows(sql`SELECT name FROM organizations WHERE id = ${org}::uuid`))[0];
if (!orgRow) refuse(`no organization ${org}`);

const HIDE_TABLES = ["service_requests", "invoices", "estimates", "customer_sessions", "customers"];

if (args.undo) {
  // Puts back exactly what one --apply changed, read from its undo record.
  let record;
  try {
    record = JSON.parse(readFileSync(args.undo, "utf8"));
  } catch (err) {
    refuse(`cannot read ${args.undo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (record.org !== org || record.host !== host) refuse(`the record is for ${record.org} on ${record.host}`);
  const sections = [...HIDE_TABLES, "pricebook_items"];
  for (const t of sections) {
    if (!Array.isArray(record[t]) || !record[t].every((id) => UUID.test(String(id)))) refuse(`the record's ${t} list is not a list of uuids`);
  }
  console.log(`${args.apply ? "Undo" : "Dry run of undo"} for ${orgRow.name} (${org}), record ${args.undo} from ${record.recordedAt}\n`);
  sections.forEach((t) => console.log(`  ${t.padEnd(18)} ${String(record[t].length).padStart(8)}`));
  if (!args.apply) {
    console.log("\nNothing was changed. Pass --apply with --undo to restore these rows.");
    process.exit(0);
  }
  const statements = HIDE_TABLES.map(
    (t) => sql`UPDATE ${sql.raw(t)} SET hidden_from_org = false WHERE organization_id = ${org}::uuid AND id = ANY(${pgArray(record[t])}::uuid[]) AND hidden_from_org`,
  );
  statements.push(
    sql`UPDATE pricebook_items SET active = true, updated_at = now() WHERE organization_id = ${org}::uuid AND id = ANY(${pgArray(record.pricebook_items)}::uuid[]) AND NOT active`,
  );
  // One batch: every table changes, or none does.
  const counts = (await db.batch(statements.map((st) => db.execute(st)))).map((r) => r.rowCount ?? 0);
  console.log("\nRestored:");
  sections.forEach((t, i) => console.log(`  ${t.padEnd(18)} ${counts[i]}`));
  renameSync(args.undo, args.undo.replace(/\.json$/, `.undone-${Date.now()}.json`));
  process.exit(0);
}

const keys = (section) => pgArray(list[section].map((e) => e.key));
const reqKeys = keys("requests");
const custKeys = keys("customers");

// Listed requests: by FieldPulse job id, or a native request's reference number.
const requests = await rows(sql`
  SELECT id, hidden_from_org,
    CASE WHEN fieldpulse_job_id = ANY(${reqKeys}::text[]) THEN fieldpulse_job_id ELSE reference_number END AS key
  FROM service_requests
  WHERE organization_id = ${org}::uuid
    AND (fieldpulse_job_id = ANY(${reqKeys}::text[]) OR reference_number = ANY(${reqKeys}::text[]))`);
const requestIds = pgArray(requests.map((r) => r.id));

// Listed customers: by FieldPulse customer id, or a native customer's row id. With
// each one's requests, for the all-junk check.
const customers = await rows(sql`
  SELECT c.id, c.hidden_from_org,
    CASE WHEN c.fieldpulse_customer_id = ANY(${custKeys}::text[]) THEN c.fieldpulse_customer_id ELSE c.id::text END AS key,
    ARRAY(SELECT s.id FROM service_requests s WHERE s.organization_id = ${org}::uuid AND s.customer_id = c.id) AS request_ids
  FROM customers c
  WHERE c.organization_id = ${org}::uuid
    AND (c.fieldpulse_customer_id = ANY(${custKeys}::text[]) OR c.id::text = ANY(${custKeys}::text[]))`);
const customerIds = pgArray(customers.map((c) => c.id));

// Invoices and estimates: listed, or on a listed request or customer. Paid money
// counts only on a synced invoice or with a payment from a real provider (the
// pre-go-live demo used the `mock` provider).
const parentMatch = (fpColumn, listed) => sql`
  organization_id = ${org}::uuid AND (${sql.raw(fpColumn)} = ANY(${listed}::text[])
    OR service_request_id = ANY(${requestIds}::uuid[]) OR customer_id = ANY(${customerIds}::uuid[]))`;
const invoices = await rows(sql`
  SELECT i.id, i.fieldpulse_invoice_id AS fieldpulse_id, i.service_request_id, i.customer_id, i.total_cents, i.hidden_from_org,
    (i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL) AS synced,
    CASE WHEN i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.provider <> 'mock')
         THEN 0 ELSE i.amount_paid_cents END AS paid_cents
  FROM invoices i WHERE ${parentMatch("fieldpulse_invoice_id", keys("invoices"))}`);
const estimates = await rows(sql`
  SELECT id, fieldpulse_estimate_id AS fieldpulse_id, service_request_id, customer_id, total_cents, hidden_from_org,
    (fieldpulse_estimate_id IS NOT NULL) AS synced, 0 AS paid_cents
  FROM estimates WHERE ${parentMatch("fieldpulse_estimate_id", keys("estimates"))}`);

const sessions = await rows(sql`
  SELECT cs.id, cs.hidden_from_org,
    ARRAY(SELECT s.id FROM service_requests s WHERE s.session_id = cs.id) AS request_ids
  FROM customer_sessions cs
  WHERE cs.organization_id = ${org}::uuid
    AND cs.id IN (SELECT session_id FROM service_requests WHERE id = ANY(${requestIds}::uuid[]))`);

const pricebook = await rows(sql`
  SELECT id, fieldpulse_item_id AS key, active FROM pricebook_items
  WHERE organization_id = ${org}::uuid AND fieldpulse_item_id = ANY(${keys("pricebookItems")}::text[])`);

const money = (r) => ({
  id: r.id,
  fieldpulseId: r.fieldpulse_id,
  requestId: r.service_request_id,
  customerId: r.customer_id,
  totalCents: Number(r.total_cents),
  paidCents: Number(r.paid_cents),
  synced: r.synced,
});
const keyed = (r) => ({ id: r.id, key: r.key });
const plan = planJunk(list, {
  requests: requests.map(keyed),
  invoices: invoices.map(money),
  estimates: estimates.map(money),
  customers: customers.map(keyed),
  customerRequests: customers.map((c) => ({ customerId: c.id, requestIds: c.request_ids })),
  sessions: sessions.map((s) => ({ id: s.id, requestIds: s.request_ids })),
  pricebookItems: pricebook.map(keyed),
});

// Rows still in the org's view (hidden flag false / item active): what --apply would change.
const hiddenFlag = new Map(
  [...requests, ...customers, ...invoices, ...estimates, ...sessions].map((r) => [r.id, r.hidden_from_org]),
);
const activeFlag = new Map(pricebook.map((p) => [p.id, p.active]));
const TABLES = [
  ["service_requests", plan.requestIds],
  ["invoices", plan.invoiceIds],
  ["estimates", plan.estimateIds],
  ["customer_sessions", plan.sessionIds],
  ["customers", plan.customerIds],
];

console.log(`${args.apply ? "Apply" : "Dry run"} for ${orgRow.name} (${org}), list ${args.list}\n`);
console.log(`  ${"table".padEnd(18)} ${"planned".padStart(8)} ${"visible".padStart(8)}`);
for (const [table, ids] of TABLES) {
  const visible = ids.filter((id) => hiddenFlag.get(id) === false).length;
  console.log(`  ${table.padEnd(18)} ${String(ids.length).padStart(8)} ${String(visible).padStart(8)}`);
}
const activeItems = plan.pricebookIds.filter((id) => activeFlag.get(id) === true).length;
console.log(`  ${"pricebook_items".padEnd(18)} ${String(plan.pricebookIds.length).padStart(8)} ${String(activeItems).padStart(8)}  (visible = active)`);
if (plan.kept.length) console.log(`\nKept for review (${plan.kept.length}):\n  ${plan.kept.join("\n  ")}`);
if (plan.notFound.length) console.log(`\nNot in this database (${plan.notFound.length}): ${plan.notFound.join(", ")}`);

if (args.apply) {
  // Exactly the rows this run changes: still visible, or still active.
  const record = {
    host,
    org,
    recordedAt: new Date().toISOString(),
    ...Object.fromEntries(TABLES.map(([table, ids]) => [table, ids.filter((id) => hiddenFlag.get(id) === false)])),
    pricebook_items: plan.pricebookIds.filter((id) => activeFlag.get(id) === true),
  };
  const total = [...TABLES.map(([table]) => record[table]), record.pricebook_items].reduce((n, ids) => n + ids.length, 0);
  if (total === 0) {
    console.log("\nEverything listed is already hidden; nothing to do.");
    process.exit(0);
  }
  // Record first, so an interrupted run can still be undone.
  const recordPath = goliveRecordPath(`golive-junk-${host}-${org}-${record.recordedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const statements = TABLES.map(
    ([table]) =>
      sql`UPDATE ${sql.raw(table)} SET hidden_from_org = true WHERE organization_id = ${org}::uuid AND id = ANY(${pgArray(record[table])}::uuid[]) AND NOT hidden_from_org`,
  );
  statements.push(
    sql`UPDATE pricebook_items SET active = false, updated_at = now() WHERE organization_id = ${org}::uuid AND id = ANY(${pgArray(record.pricebook_items)}::uuid[]) AND active`,
  );
  // One batch: every table changes, or none does.
  const counts = (await db.batch(statements.map((s) => db.execute(s)))).map((r) => r.rowCount ?? 0);
  console.log("\nHid:");
  [...TABLES.map(([t]) => t), "pricebook_items"].forEach((t, i) => console.log(`  ${t.padEnd(18)} ${counts[i]}`));
  console.log(`\nUndo record: ${recordPath}`);
} else {
  console.log("\nNothing was changed. Pass --apply to hide; undo later with --undo <record> --apply.");
}
