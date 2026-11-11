#!/usr/bin/env node
/**
 * Go-live polish of an org's shipped defaults: the residential demo pricebook
 * items and the "Comfort Club" demo plan are deactivated (never deleted), the
 * seeded message-template names go to sentence case (Job completed → Visit
 * completed), and an unset brand color becomes the Spears navy from the logo.
 * Template bodies are not touched. Rows are found by name/key, so the same run
 * works on dev and prod. The rules live in src/lib/admin/golive-polish-defaults.ts.
 *
 *   npx tsx scripts/agent/golive-polish-defaults.mjs --org <uuid>                  # dry run
 *   npx tsx scripts/agent/golive-polish-defaults.mjs --org <uuid> --apply          # change
 *   npx tsx scripts/agent/golive-polish-defaults.mjs --org <uuid> --undo           # dry run of the undo
 *   npx tsx scripts/agent/golive-polish-defaults.mjs --org <uuid> --undo --apply   # put back
 *   add --record <file> to choose where prior values are kept
 *   (default ~/.hvac-golive/golive-polish-defaults-<host>-<org>.json)
 *
 * --apply writes every prior value to the record file BEFORE changing anything,
 * and is idempotent (a second run plans nothing). --undo --apply restores each
 * recorded field still holding the value --apply wrote; a field edited since is
 * skipped. Demo pricebook items match on name, seeded price, no SKU and a
 * creation date before the 2026-07-09 branch split, so a real native item with
 * the same name is never deactivated.
 *
 * Any run against the production host (ep-withered-hill, any letter case)
 * needs --prod; only the user passes it, never an agent.
 * DATABASE_URL comes from the environment, else (not with --prod) from
 * .env.local (scripts/agent/golive-env.mjs).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { goliveRecordPath, loadGoliveEnv } from "./golive-env.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, record: null, apply: false, undo: false, prod: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--record") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--apply" || arg === "--undo" || arg === "--prod") {
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

let host;
try {
  host = new URL(url).hostname.split(".")[0].toLowerCase();
} catch {
  refuse("DATABASE_URL is not a valid URL");
}
const org = args.org;
const recordPath = args.record ?? goliveRecordPath(`golive-polish-defaults-${host}-${org}.json`);

const { planPolish, planUndo, mergeRecord, parsePolishRecord, polishFieldKey } = await import(
  "../../src/lib/admin/golive-polish-defaults.ts"
);
const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { sql } = await import("drizzle-orm");
const db = drizzle(neon(url));
const rows = async (statement) => (await db.execute(statement)).rows;

const orgRow = (await rows(sql`SELECT name FROM organizations WHERE id = ${org}::uuid`))[0];
if (!orgRow) refuse(`no organization ${org}`);

// Whitelisted identifiers and casts: the only raw SQL in this script.
const COLUMN_CAST = { active: "boolean", name: "text", primary_color: "text" };
const ID_COLUMN = {
  pricebook_items: "id",
  membership_plans: "id",
  communication_templates: "id",
  organization_settings: "organization_id",
};

/** Compare-and-set: the field changes only while it still holds `from`. */
function setStatement(change) {
  const cast = sql.raw(COLUMN_CAST[change.column]);
  return sql`UPDATE ${sql.raw(change.table)}
    SET ${sql.raw(change.column)} = ${change.to}::${cast}, updated_at = now()
    WHERE ${sql.raw(ID_COLUMN[change.table])} = ${change.id}::uuid
      AND organization_id = ${org}::uuid
      AND ${sql.raw(change.column)} IS NOT DISTINCT FROM ${change.from}::${cast}`;
}

async function applyChanges(changes) {
  if (changes.length === 0) return [];
  // One batch: every field changes, or none does.
  return (await db.batch(changes.map((c) => db.execute(setStatement(c))))).map((r) => r.rowCount ?? 0);
}

function printChanges(title, changes) {
  console.log(`\n${title} (${changes.length}):`);
  for (const c of changes) console.log(`  ${c.table.padEnd(24)} ${c.column.padEnd(14)} ${c.label}`);
}

console.log(`${args.undo ? (args.apply ? "Undo" : "Dry run of undo") : args.apply ? "Apply" : "Dry run"} for ${orgRow.name} (${org}) on ${host}`);
console.log(`Record file: ${recordPath}`);

if (args.undo) {
  if (!existsSync(recordPath)) refuse(`no record file at ${recordPath}; pass --record <file> from the --apply run`);
  let record;
  try {
    record = parsePolishRecord(JSON.parse(readFileSync(recordPath, "utf8")));
  } catch (err) {
    refuse(`cannot read ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (record.host !== host || record.org !== org) refuse(`the record is for ${record.org} on ${record.host}`);

  // Current value of every recorded field (a missing row simply has no entry).
  const current = new Map();
  for (const c of record.changes) {
    const found = await rows(sql`SELECT ${sql.raw(c.column)} AS value FROM ${sql.raw(c.table)}
      WHERE ${sql.raw(ID_COLUMN[c.table])} = ${c.id}::uuid AND organization_id = ${org}::uuid`);
    if (found[0]) current.set(polishFieldKey(c), found[0].value);
  }
  const { restore, skipped } = planUndo(record.changes, current);
  printChanges("Restore", restore);
  if (skipped.length) printChanges("Skipped: changed since --apply, or gone", skipped);
  if (!args.apply) {
    console.log("\nNothing was changed. Pass --apply with --undo to restore these fields.");
    process.exit(0);
  }
  const counts = await applyChanges(restore);
  console.log(`\nRestored ${counts.reduce((a, b) => a + b, 0)} of ${restore.length}.`);
  renameSync(recordPath, recordPath.replace(/\.json$/, `.undone-${Date.now()}.json`));
  process.exit(0);
}

const pricebook = await rows(sql`
  SELECT id, name, active, fieldpulse_item_id, price_cents, sku, created_at FROM pricebook_items WHERE organization_id = ${org}::uuid`);
const plans = await rows(sql`
  SELECT p.id, p.name, p.price_cents, p.billing_period::text AS billing_period, p.active,
    (SELECT count(*) FROM customer_memberships m WHERE m.plan_id = p.id AND m.status = 'active') AS active_members
  FROM membership_plans p WHERE p.organization_id = ${org}::uuid`);
const templates = await rows(sql`
  SELECT id, key, name, subject_template, body_template FROM communication_templates WHERE organization_id = ${org}::uuid`);
const settings = (await rows(sql`
  SELECT organization_id, primary_color, company_name FROM organization_settings WHERE organization_id = ${org}::uuid`))[0];

const changes = planPolish({
  pricebook: pricebook.map((p) => ({
    id: p.id,
    name: p.name,
    active: p.active,
    fieldpulseItemId: p.fieldpulse_item_id,
    priceCents: Number(p.price_cents),
    sku: p.sku,
    createdAt: new Date(p.created_at),
  })),
  plans: plans.map((p) => ({
    id: p.id,
    name: p.name,
    priceCents: Number(p.price_cents),
    billingPeriod: p.billing_period,
    active: p.active,
  })),
  templates: templates.map((t) => ({ id: t.id, key: t.key, name: t.name })),
  settings: settings ? { organizationId: settings.organization_id, primaryColor: settings.primary_color } : null,
});

// Context for the operator; nothing below changes data.
const fpActive = pricebook.filter((p) => p.fieldpulse_item_id !== null && p.active).length;
const nativeActive = pricebook.filter((p) => p.fieldpulse_item_id === null && p.active).length;
const deactivating = changes.filter((c) => c.table === "pricebook_items").length;
console.log(`\nPricebook: ${fpActive} active FieldPulse items, ${nativeActive} active native items (${deactivating} of them demo).`);
if (fpActive === 0) console.log("  No FieldPulse items: the pricebook will show its empty state once the demo items go.");
for (const c of changes.filter((ch) => ch.table === "membership_plans")) {
  const members = Number(plans.find((p) => p.id === c.id)?.active_members ?? 0);
  if (members > 0) console.log(`Plan "${c.label}" keeps ${members} active enrollment(s); deactivating stops new ones only.`);
}
const offBrand = templates.filter((t) => /spears hvac/i.test(`${t.subject_template ?? ""} ${t.body_template}`));
console.log(`Template bodies naming "Spears HVAC": ${offBrand.length ? offBrand.map((t) => t.key).join(", ") : "none"}.`);
if (settings) console.log(`Company name used as {{companyName}}: ${settings.company_name ?? "(unset)"}.`);
else console.log("No organization_settings row: the brand color is left unset.");

printChanges("Planned", changes);

if (!args.apply) {
  console.log("\nNothing was changed. Pass --apply to make these changes; undo later with --undo --apply.");
  process.exit(0);
}
if (changes.length === 0) {
  console.log("\nAlready polished; nothing to do.");
  process.exit(0);
}

// Record first, so an interrupted run can still be undone.
let earlier = [];
if (existsSync(recordPath)) {
  try {
    const record = parsePolishRecord(JSON.parse(readFileSync(recordPath, "utf8")));
    if (record.host !== host || record.org !== org) refuse(`${recordPath} is for ${record.org} on ${record.host}`);
    earlier = record.changes;
  } catch (err) {
    refuse(`cannot read ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
mkdirSync(dirname(recordPath), { recursive: true });
writeFileSync(
  recordPath,
  `${JSON.stringify({ host, org, recordedAt: new Date().toISOString(), changes: mergeRecord(earlier, changes) }, null, 2)}\n`,
);

const counts = await applyChanges(changes);
const done = counts.reduce((a, b) => a + b, 0);
console.log(`\nChanged ${done} of ${changes.length}.${done < changes.length ? " (Some rows changed between plan and apply; re-run to see.)" : ""}`);
