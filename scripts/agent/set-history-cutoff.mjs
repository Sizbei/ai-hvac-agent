#!/usr/bin/env node
/**
 * Go-live audit cutoff (P8 M7): store the go-live moment as
 * `organizations.feature_flags.historyCutoff`. Org viewers who don't see hidden
 * history then see audit-log entries only from that moment on; the platform
 * owner (not previewing) still sees everything. Run it alongside
 * `golive-hide-history.mjs --apply` (the builder, historyCutoffPatchSql in
 * src/lib/admin/history-cutoff-sql.ts, can also join that script's batch).
 *
 *   npx tsx scripts/agent/set-history-cutoff.mjs --org <uuid>                      # now
 *   npx tsx scripts/agent/set-history-cutoff.mjs --org <uuid> --at 2026-11-10T22:00:00Z
 *
 * --at must not be in the future. A running app instance picks the new cutoff
 * up within 30 s (the org row TTL cache, src/lib/tenancy/org-row.ts).
 *
 * Any run against the production host (ep-withered-hill) needs --prod; only the
 * user passes it, never an agent. DATABASE_URL comes from the environment, else
 * from .env.local.
 */
import { existsSync, readFileSync } from "node:fs";

const PROD_HOST = "ep-withered-hill";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { org: null, at: null, prod: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--at") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--prod") {
      out.prod = true;
    } else {
      refuse(`unknown argument ${arg}`);
    }
  }
  if (!out.org || !UUID.test(out.org)) refuse("--org must be an organization uuid");
  if (out.at !== null && Number.isNaN(new Date(out.at).getTime())) refuse("--at must be an ISO timestamp");
  // A future cutoff would hide entries written between now and then.
  if (out.at !== null && new Date(out.at).getTime() > Date.now()) refuse("--at can't be in the future");
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
if (url.includes(PROD_HOST) && !args.prod) refuse("this is the production database; pass --prod to run against it");

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { sql } = await import("drizzle-orm");
const { historyCutoffPatchSql } = await import("../../src/lib/admin/history-cutoff-sql.ts");

const db = drizzle(neon(url));
const org = (await db.execute(sql`SELECT name FROM organizations WHERE id = ${args.org}::uuid`)).rows[0];
if (!org) refuse(`no organization ${args.org}`);

const at = args.at ?? new Date().toISOString();
const stored = (await db.execute(historyCutoffPatchSql(args.org, at))).rows[0]?.history_cutoff;
console.log(`Audit log cutoff for ${org.name} (${args.org}) set to ${stored}.`);
