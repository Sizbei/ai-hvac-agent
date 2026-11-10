#!/usr/bin/env node
/**
 * Go-live Task 30: fill an org's EMPTY settings with the verified public
 * Spears facts (src/lib/admin/settings-prefill.ts). Existing values always
 * win, business hours and the logo are never set (unverified / no asset).
 *
 *   npx tsx scripts/agent/prefill-org-settings.mjs --org <uuid>            # dry run
 *   npx tsx scripts/agent/prefill-org-settings.mjs --org <uuid> --report   # empty key NAMES only
 *   npx tsx scripts/agent/prefill-org-settings.mjs --org <uuid> --apply    # one UPDATE statement
 *
 * Safety: on the production host (ep-withered-hill) it refuses unless --prod
 * is passed; only the user/controller passes it, never an implementing agent.
 * DATABASE_URL comes from the environment, else from .env.local.
 */
import { existsSync, readFileSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, apply: false, report: false, prod: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse("missing value for --org");
      out.org = value;
      i += 1;
    } else if (arg === "--apply" || arg === "--report" || arg === "--prod") {
      out[arg.slice(2)] = true;
    } else {
      refuse(`unknown argument ${arg}`);
    }
  }
  if (!out.org || !UUID.test(out.org)) refuse("--org must be an organization uuid");
  if (out.apply && out.report) refuse("--apply and --report cannot be combined");
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^"|"$/g, "");
  }
}
const url = process.env.DATABASE_URL ?? "";
if (!url) refuse("DATABASE_URL is not set");
const p = await import("../../src/lib/admin/settings-prefill.ts");
// Before any connection: the database modules are imported only past this line.
if (p.isProdDatabaseUrl(url) && !args.prod) refuse("this is the production database; pass --prod to run against it");

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { sql } = await import("drizzle-orm");

const db = drizzle(neon(url));
const rows = async (statement) => (await db.execute(statement)).rows;

const row = (
  await rows(sql`SELECT o.name AS org_name, s.company_name, s.logo_url, s.business_info, s.after_hours_config
    FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id
    WHERE o.id = ${args.org}::uuid`)
)[0];
if (!row) refuse(`no organization ${args.org}`);
const info = row.business_info && typeof row.business_info === "object" ? row.business_info : {};
const hoursConfig = row.after_hours_config && typeof row.after_hours_config === "object" ? row.after_hours_config : null;
const current = {
  companyName: row.company_name,
  logoUrl: row.logo_url,
  businessInfo: info,
  timezone: hoursConfig?.timezone ?? null,
};

if (args.report) {
  const r = p.emptyKeyReport(current);
  console.log(`Empty settings keys for org ${args.org} (names only):`);
  for (const k of r.empty) console.log(`  ${k}`);
  console.log("\nConfirm with Chick:");
  for (const k of r.confirmWithChick) console.log(`  - ${k}`);
  process.exit(0);
}

const patch = p.prefillPatch(current, p.SPEARS_FACTS);
// An unset after_hours_config means "system default"; do not create one just for a timezone.
if (!hoursConfig) delete patch.timezone;

const fills = [
  ...(patch.companyName ? ["company_name"] : []),
  ...(patch.timezone ? ["after_hours_config.timezone"] : []),
  ...Object.keys(patch.businessInfo ?? {}).map((k) => `business_info.${k}`),
];

console.log(`${args.apply ? "Applying to" : "Dry run for"} ${row.org_name} (${args.org})${args.apply ? "" : ". Nothing was changed."}`);
console.log(fills.length ? (args.apply ? "Filling:" : "Would fill:") : "Nothing to fill; every verified key already has a value.");
for (const k of fills) console.log(`  ${k}`);
console.log("Never set: business_info.businessHours (unverified), logo_url (no asset).");
if (!hoursConfig) console.log("after_hours_config is unset (system default); timezone left alone.");

if (args.apply && fills.length) {
  const info$ = JSON.stringify(patch.businessInfo ?? {});
  const company = patch.companyName ?? null;
  const tz = patch.timezone ?? null;
  // One statement; every CASE re-checks emptiness so an existing value wins even under a race.
  const result = await db.execute(sql`UPDATE organization_settings SET
    company_name = CASE WHEN company_name IS NULL OR btrim(company_name) = '' THEN COALESCE(${company}::text, company_name) ELSE company_name END,
    business_info = ${info$}::jsonb || COALESCE((
      SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(business_info) e
      WHERE NOT (jsonb_typeof(e.value) = 'null' OR (jsonb_typeof(e.value) = 'string' AND btrim(e.value #>> '{}') = ''))
    ), '{}'::jsonb),
    after_hours_config = CASE
      WHEN ${tz}::text IS NOT NULL AND jsonb_typeof(after_hours_config) = 'object'
        AND COALESCE(btrim(after_hours_config->>'timezone'), '') = ''
      THEN after_hours_config || jsonb_build_object('timezone', ${tz}::text)
      ELSE after_hours_config END
    WHERE organization_id = ${args.org}::uuid`);
  console.log(`Updated ${result.rowCount ?? 0} settings row.`);
}
