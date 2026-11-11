#!/usr/bin/env node
/**
 * Go-live marking (P6): hide an org's pre-go-live history from that org's own
 * view (`hidden_from_org = true`, migration 0059). Rows are never deleted; the
 * platform owner still sees everything, and --unhide restores it all.
 *
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid>                       # dry run, all three modes
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --mode history --apply
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --mode empty --apply --reapply
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --mode seeded --apply   # fictional seed rows only
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --unhide                      # dry run
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --unhide --apply
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --unhide-fieldpulse           # dry run
 *   npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> --unhide-fieldpulse --apply
 *   add --stale-days <n> (default 60) to a dry run or a history --apply
 *
 * Modes (src/lib/admin/golive-marking-sql.ts):
 *   history  keeps requests not yet closed and created within --stale-days, visits
 *            from today, open AR, open estimates active in the last 90 days (and
 *            any estimate an open invoice references),
 *            resumable conversations updated in the last 14 days, and their customers
 *   empty    keeps only visits from today, those recent resumable conversations
 *            and their customers
 *   seeded   hides ONLY the seeded rows below (and customers whose only links are
 *            seeded rows); keeps everything else, including all imported history
 *   All three hide the seeded HVAC-DEMO / HVAC-CAP requests, demo-seed- / demo-cap- sessions
 *   and the sessions of seeded requests.
 *
 * --unhide-fieldpulse un-hides ONLY FieldPulse-IMPORTED history: requests the
 *   importer created (synthetic fp-import- session), FieldPulse invoices and
 *   estimates (only ever pulled), and customers with imported work or with a
 *   FieldPulse id and no native request. Native requests pushed to FieldPulse
 *   (and customers whose only work is native) are listed for review and left
 *   as they are, as are conversations, seeded rows and the history cutoff.
 *   Requests in a fp-hide-deleted-jobs undo file in ~/.hvac-golive/ (FieldPulse
 *   deleted the job) stay hidden too, with their invoices and estimates.
 *   Dry run unless --apply. Run golive-hide-junk.mjs --apply after it: it
 *   brings FieldPulse test rows back too. --mode does not apply.
 *
 * --apply refuses when it would hide any VISIBLE imported FieldPulse row
 *   (FieldPulse history is shown on purpose since 2026-11-11; the sync and the
 *   backfill also re-date rows before the cutoff), unless --hide-fieldpulse.
 *
 * Safety (plan ruling 5): --apply refuses when the org already has hidden rows
 * unless --reapply is passed. --reapply only hides more (it never un-hides);
 * once the org has a go-live cutoff (set-history-cutoff.mjs) no run hides a row
 * created from the cutoff on. To switch modes run --unhide first, then --apply.
 * Note: --reapply DOES re-hide pre-cutoff rows that migration 0061 un-hid
 * through activity (a live status change, a reschedule, a visit move, an
 * invoice reopening, a new message); the cutoff bounds only by created_at.
 * --unhide also clears the cutoff, and is a dry run unless --apply. A
 * malformed cutoff makes the dry run and --apply refuse; --unhide still runs
 * (and clears it). Any run against the production host (ep-withered-hill, any
 * letter case) needs --prod; only the user passes it, never an agent.
 * DATABASE_URL comes from the environment, else (not with --prod) from
 * .env.local (scripts/agent/golive-env.mjs).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GOLIVE_DIR, loadGoliveEnv } from "./golive-env.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_WARNING = "Warning: open invoices will be hidden, but dunning keeps reminding those customers.";

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, mode: "history", modeGiven: false, apply: false, reapply: false, unhide: false, unhideFieldpulse: false, hideFieldpulse: false, prod: false, staleDays: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--mode") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      if (arg === "--mode") out.modeGiven = true;
      i += 1;
    } else if (arg === "--stale-days") {
      const value = argv[i + 1];
      if (value === undefined || !/^[1-9][0-9]{0,4}$/.test(value)) refuse("--stale-days must be a whole number of days from 1 to 99999");
      out.staleDays = Number(value);
      i += 1;
    } else if (arg === "--apply" || arg === "--reapply" || arg === "--unhide" || arg === "--prod") {
      out[arg.slice(2)] = true;
    } else if (arg === "--unhide-fieldpulse") {
      out.unhideFieldpulse = true;
    } else if (arg === "--hide-fieldpulse") {
      out.hideFieldpulse = true;
    } else {
      refuse(`unknown argument ${arg}`);
    }
  }
  if (!out.org || !UUID.test(out.org)) refuse("--org must be an organization uuid");
  if (out.mode !== "history" && out.mode !== "empty" && out.mode !== "seeded") refuse("--mode must be history, empty or seeded");
  if (out.unhideFieldpulse && (out.unhide || out.reapply || out.staleDays !== null || out.modeGiven)) {
    refuse("--unhide-fieldpulse cannot be combined with --unhide, --reapply, --stale-days or --mode");
  }
  if (out.unhide && (out.reapply || out.modeGiven)) refuse("--unhide cannot be combined with --reapply or --mode");
  if (out.reapply && !out.apply) refuse("--reapply only goes with --apply");
  if (out.hideFieldpulse && (!out.apply || out.unhide || out.unhideFieldpulse)) refuse("--hide-fieldpulse only goes with a marking --apply");
  if (out.staleDays !== null && out.unhide) refuse("--stale-days does not go with --unhide");
  if (out.staleDays !== null && out.mode !== "history") refuse("--stale-days only applies to --mode history");
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Before any connection: the database modules are imported only past this line.
const url = loadGoliveEnv({ prod: args.prod, keys: ["DATABASE_URL"] });

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
if (!args.unhide && !args.unhideFieldpulse && historyCutoff(org.feature_flags)?.toISOString() === MALFORMED_HISTORY_CUTOFF_ISO) {
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
  console.log(`  ${"table".padEnd(18)} ${"total".padStart(8)} ${"hidden".padStart(8)} ${"history".padStart(8)} ${"empty".padStart(8)} ${"seeded".padStart(8)}`);
  for (const t of m.MARKED_TABLES) {
    const cells = ["total", "hidden", "hide_history", "hide_empty", "hide_seeded"].map((c) => String(d[`${t}_${c}`]).padStart(8));
    console.log(`  ${t.padEnd(18)} ${cells.join(" ")}`);
  }
  console.log("\n  history / empty / seeded = rows each mode's --apply would newly hide.");
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

/**
 * Rows the fp-hide-deleted-jobs undo files for this org hid (FieldPulse deleted
 * the job). An undone file is renamed *.undone-*.json and no longer counts.
 */
function deletedJobsKeepHidden() {
  const keep = { invoices: [], estimates: [], service_requests: [] };
  const files = existsSync(GOLIVE_DIR)
    ? readdirSync(GOLIVE_DIR).filter((f) => /^fp-deleted-jobs-hidden-.*\.json$/.test(f) && !f.includes(".undone-"))
    : [];
  const used = [];
  for (const f of files) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(GOLIVE_DIR, f), "utf8"));
    } catch {
      refuse(`cannot read ${join(GOLIVE_DIR, f)}`);
    }
    if (m.org !== args.org) continue;
    const ids = [...(m.requests ?? []).map((r) => r.id), ...(m.invoices ?? []), ...(m.estimates ?? [])];
    if (!ids.every((id) => UUID.test(String(id)))) refuse(`${join(GOLIVE_DIR, f)} holds an id that is not a uuid`);
    keep.service_requests.push(...(m.requests ?? []).map((r) => r.id));
    keep.invoices.push(...(m.invoices ?? []));
    keep.estimates.push(...(m.estimates ?? []));
    used.push(f);
  }
  return { keep, used };
}

if (args.unhideFieldpulse) {
  const { keep, used } = deletedJobsKeepHidden();
  const d = (await rows(m.unhideFieldpulseDryRunSql(args.org, keep)))[0];
  console.log(used.length
    ? `Deleted-jobs undo files kept hidden (${GOLIVE_DIR}): ${used.join(", ")}`
    : `No deleted-jobs undo file for this org in ${GOLIVE_DIR}.`);
  if (args.apply) {
    const counts = await runBatch(m.unhideFieldpulseStatements(args.org, keep));
    console.log(`Unhid imported FieldPulse history for ${org.name} (${args.org}):`);
    m.FIELDPULSE_TABLES.forEach((t, i) => console.log(`  ${t.padEnd(18)} ${counts[i]}`));
  } else {
    console.log(`Dry run for ${org.name} (${args.org}): hidden imported FieldPulse rows --unhide-fieldpulse --apply would restore. Nothing was changed.`);
    console.log(`  ${"table".padEnd(18)} ${"restore".padStart(8)} ${"kept".padStart(8)}`);
    m.FIELDPULSE_TABLES.forEach((t) => console.log(`  ${t.padEnd(18)} ${String(d[`${t}_fp_hidden`]).padStart(8)} ${String(d[`${t}_fp_kept`]).padStart(8)}`));
    console.log("  kept = in a deleted-jobs undo file.");
  }
  const natives = [...d.native_requests, ...d.native_customers];
  console.log(`\nNative rows with FieldPulse links, left hidden for review (${natives.length}):`);
  if (d.native_requests.length) console.log(`  requests pushed to FieldPulse: ${d.native_requests.join(", ")}`);
  if (d.native_customers.length) console.log(`  customers with only native work (row ids): ${d.native_customers.join(", ")}`);
  if (args.apply) console.log("\nConversations, native requests and the history cutoff are unchanged. Now run golive-hide-junk.mjs --apply.");
} else if (args.unhide) {
  const t = m.MARKED_TABLES;
  const hidden = (await rows(sql`SELECT ${sql.join(t.map((table) => sql`(SELECT count(*) FROM ${sql.raw(table)} WHERE organization_id = ${args.org}::uuid AND hidden_from_org)::int AS ${sql.raw(table)}`), sql`, `)}`))[0];
  if (args.apply) {
    // One batch: the rows come back and the audit cutoff goes, or neither does.
    const counts = await runBatch([...m.unhideStatements(args.org), clearHistoryCutoffSql(args.org)]);
    printPerTable(`Unhid rows for ${org.name} (${args.org}):`, counts);
    console.log("Audit log cutoff cleared.");
  } else {
    printPerTable(`Dry run for ${org.name} (${args.org}): --unhide --apply would show every hidden row again and clear the history cutoff. Nothing was changed.`, t.map((table) => hidden[table]));
  }
} else if (args.apply) {
  const hidden = (await rows(m.dryRunSql(args.org, staleDays)))[0];
  const already = m.MARKED_TABLES.reduce((n, t) => n + Number(hidden[`${t}_hidden`]), 0);
  if (already > 0 && !args.reapply) {
    refuse(`${org.name} already has ${already} hidden rows; pass --reapply to mark again`);
  }
  const rehide = (await rows(m.fieldpulseRehideSql(args.org, args.mode, staleDays)))[0];
  const rehideTotal = m.FIELDPULSE_TABLES.reduce((n, t) => n + Number(rehide[`${t}_fp_rehide`]), 0);
  if (rehideTotal > 0 && !args.hideFieldpulse) {
    refuse(`this would hide ${rehideTotal} visible imported FieldPulse rows (${m.FIELDPULSE_TABLES.map((t) => `${t} ${rehide[`${t}_fp_rehide`]}`).join(", ")}); pass --hide-fieldpulse if that is intended`);
  }
  if (args.mode === "empty") console.log(EMPTY_WARNING);
  printPerTable(`Hid rows for ${org.name} (${args.org}), mode ${args.mode}:`, await runBatch(m.markStatements(args.org, args.mode, staleDays)));
} else {
  await dryRun();
}
