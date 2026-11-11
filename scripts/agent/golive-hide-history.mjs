#!/usr/bin/env node
/**
 * Go-live marking (P6): hide an org's pre-go-live history from that org's own
 * view (`hidden_from_org = true`, migration 0059). Rows are never deleted; the
 * platform owner still sees everything, and --unhide restores it all.
 *
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid>                       # dry run, both modes
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --mode history --apply
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --mode empty --apply --reapply
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --unhide
 *   add --stale-days <n> (default 60) to a dry run or a history --apply
 *
 * Modes (src/lib/admin/golive-marking-sql.ts):
 *   history  keeps requests not yet closed and created within --stale-days, visits
 *            from today, open AR, open estimates active in the last 90 days (and
 *            any estimate an open invoice references),
 *            resumable conversations updated in the last 14 days, and their customers
 *   empty    keeps only visits from today, those recent resumable conversations
 *            and their customers
 *   Both hide the seeded HVAC-DEMO / HVAC-CAP requests, demo-seed- / demo-cap- sessions
 *   and the sessions of seeded requests.
 *
 * Safety (plan ruling 5): --apply refuses when the org already has hidden rows
 * unless --reapply is passed. --reapply only hides more (it never un-hides);
 * once the org has a go-live cutoff (set-history-cutoff.mjs) no run hides a row
 * created from the cutoff on. To switch modes run --unhide first, then --apply.
 * --unhide also clears the cutoff. A malformed cutoff makes the dry run and
 * --apply refuse; --unhide still runs (and clears it). Any run against the
 * production host (ep-withered-hill, any letter case) needs --prod; only the
 * user passes it, never an agent.
 * DATABASE_URL comes from the environment, else from .env.local.
 */
import { existsSync, readFileSync } from "node:fs";

const PROD_HOST = "ep-withered-hill";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_WARNING = "Warning: open invoices will be hidden, but dunning keeps reminding those customers.";

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, mode: "history", apply: false, reapply: false, unhide: false, prod: false, staleDays: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--mode") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--stale-days") {
      const value = argv[i + 1];
      if (value === undefined || !/^[1-9][0-9]{0,4}$/.test(value)) refuse("--stale-days must be a whole number of days from 1 to 99999");
      out.staleDays = Number(value);
      i += 1;
    } else if (arg === "--apply" || arg === "--reapply" || arg === "--unhide" || arg === "--prod") {
      out[arg.slice(2)] = true;
    } else {
      refuse(`unknown argument ${arg}`);
    }
  }
  if (!out.org || !UUID.test(out.org)) refuse("--org must be an organization uuid");
  if (out.mode !== "history" && out.mode !== "empty") refuse("--mode must be history or empty");
  if (out.apply && out.unhide) refuse("--apply and --unhide cannot be combined");
  if (out.reapply && !out.apply) refuse("--reapply only goes with --apply");
  if (out.staleDays !== null && out.unhide) refuse("--stale-days does not go with --unhide");
  if (out.staleDays !== null && out.mode === "empty") refuse("--stale-days only applies to --mode history");
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
// Before any connection: the database modules are imported only past this line.
// Hostnames are case-insensitive: match the production host in any letter case.
if (url.toLowerCase().includes(PROD_HOST) && !args.prod) refuse("this is the production database; pass --prod to run against it");

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { sql } = await import("drizzle-orm");
const m = await import("../../src/lib/admin/golive-marking-sql.ts");
const { clearHistoryCutoffSql } = await import("../../src/lib/admin/history-cutoff-sql.ts");
const { historyCutoff, MALFORMED_HISTORY_CUTOFF_ISO } = await import("../../src/lib/tenancy/feature-flags.ts");

const db = drizzle(neon(url));
const staleDays = args.staleDays ?? m.DEFAULT_STALE_DAYS;
const rows = async (statement) => (await db.execute(statement)).rows;
const runBatch = async (statements) =>
  (await db.batch(statements.map((s) => db.execute(s)))).map((r) => r.rowCount ?? 0);

const org = (await rows(sql`SELECT name, feature_flags FROM organizations WHERE id = ${args.org}::uuid`))[0];
if (!org) refuse(`no organization ${args.org}`);
if (!args.unhide && historyCutoff(org.feature_flags)?.toISOString() === MALFORMED_HISTORY_CUTOFF_ISO) {
  refuse("the organization's historyCutoff is not a timestamp; fix it with set-history-cutoff.mjs or clear it with --unhide");
}

const dollars = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

function printPerTable(label, counts) {
  console.log(label);
  m.MARKED_TABLES.forEach((t, i) => console.log(`  ${t.padEnd(18)} ${counts[i]}`));
}

async function dryRun() {
  const d = (await rows(m.dryRunSql(args.org, staleDays)))[0];
  console.log(`Dry run for ${org.name} (${args.org}), stale cut ${staleDays} days. Nothing was changed.\n`);
  console.log(`  ${"table".padEnd(18)} ${"total".padStart(8)} ${"hidden".padStart(8)} ${"history".padStart(8)} ${"empty".padStart(8)}`);
  for (const t of m.MARKED_TABLES) {
    const cells = ["total", "hidden", "hide_history", "hide_empty"].map((c) => String(d[`${t}_${c}`]).padStart(8));
    console.log(`  ${t.padEnd(18)} ${cells.join(" ")}`);
  }
  console.log("\n  history / empty = rows each mode's --apply would newly hide.");
  console.log(`\nhistory: hides ${d.stale_requests_hidden} open requests older than ${staleDays} days with no visit from today (--stale-days).`);
  console.log(`history: keeps ${d.old_open_requests_kept} open requests older than ${staleDays} days because an open invoice or estimate is on them.`);
  console.log(`history: hides ${d.stale_estimates_hidden} open estimates inactive for 90 days (FieldPulse estimates by creation date).`);
  console.log(`both: hide ${d.stale_sessions_hidden} resumable conversations idle for 14 days (history count).`);
  console.log(`both: hide ${d.seeded_requests_hidden} seeded HVAC-DEMO / HVAC-CAP requests.`);
  console.log(`both: hide ${d.seeded_sessions_hidden} seeded conversations (demo-seed- / demo-cap- tokens, or a seeded request's).`);
  console.log(`empty: hides ${dollars(d.open_ar_cents_hidden_in_empty)} of open invoice balance.`);
  console.log(`empty: ${EMPTY_WARNING}`);
  return d;
}

if (args.unhide) {
  // One batch: the rows come back and the audit cutoff goes, or neither does.
  const counts = await runBatch([...m.unhideStatements(args.org), clearHistoryCutoffSql(args.org)]);
  printPerTable(`Unhid rows for ${org.name} (${args.org}):`, counts);
  console.log("Audit log cutoff cleared.");
} else if (args.apply) {
  const hidden = (await rows(m.dryRunSql(args.org, staleDays)))[0];
  const already = m.MARKED_TABLES.reduce((n, t) => n + Number(hidden[`${t}_hidden`]), 0);
  if (already > 0 && !args.reapply) {
    refuse(`${org.name} already has ${already} hidden rows; pass --reapply to mark again`);
  }
  if (args.mode === "empty") console.log(EMPTY_WARNING);
  printPerTable(`Hid rows for ${org.name} (${args.org}), mode ${args.mode}:`, await runBatch(m.markStatements(args.org, args.mode, staleDays)));
} else {
  await dryRun();
}
