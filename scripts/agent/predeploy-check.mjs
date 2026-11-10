#!/usr/bin/env node
/**
 * Pre-deploy checklist. Read-only: it checks env var NAMES (never values),
 * never calls `vercel env pull`, and never deploys.
 *
 *   npx tsx scripts/agent/predeploy-check.mjs                    # --env production
 *   npx tsx scripts/agent/predeploy-check.mjs --env preview
 *
 * Checks:
 *   - `vercel whoami` succeeds
 *   - `vercel env ls <env>` lists every required name (src/lib/env-validation.ts
 *     requiredEnvNames(); production also PLATFORM_ADMIN_EMAILS, PLATFORM_ORG_ID,
 *     NEXT_PUBLIC_APP_URL) and, for production, not DEMO_MODE_ORG_IDS.
 *     RESEND_API_KEY missing is a warning only.
 *   - the newest drizzle/*.sql is the last _journal.json entry
 *   - production only: on main, tracked tree clean (untracked files ignored),
 *     HEAD equals origin/main (after a fetch)
 * Prints one line per failure and exits 1, or exits 0.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { requiredEnvNames } from "../../src/lib/env-validation.ts";
import { envCheck, migrationTagMismatch, parseVercelEnvLs } from "../../src/lib/deploy/env-check.ts";

const PRODUCTION_EXTRA = ["PLATFORM_ADMIN_EMAILS", "PLATFORM_ORG_ID", "NEXT_PUBLIC_APP_URL"];
const PRODUCTION_FORBIDDEN = ["DEMO_MODE_ORG_IDS"];
const WARN_IF_MISSING = ["RESEND_API_KEY"];

function parseEnv(argv) {
  if (argv.length === 0) return "production";
  if (argv.length === 2 && argv[0] === "--env" && (argv[1] === "production" || argv[1] === "preview")) {
    return argv[1];
  }
  console.error("Usage: npx tsx scripts/agent/predeploy-check.mjs [--env production|preview]");
  process.exit(1);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", input: "", timeout: 60_000 });
  return { ok: !res.error && res.status === 0, stdout: res.stdout ?? "" };
}

const env = parseEnv(process.argv.slice(2));
const failures = [];
const warnings = [];

if (!run("vercel", ["whoami"]).ok) {
  failures.push("vercel whoami failed (not signed in; run vercel login)");
} else {
  const ls = run("vercel", ["env", "ls", env]);
  if (!ls.ok) {
    failures.push(`vercel env ls ${env} failed`);
  } else {
    const present = parseVercelEnvLs(ls.stdout);
    const required = [...new Set([...requiredEnvNames(), ...(env === "production" ? PRODUCTION_EXTRA : [])])];
    const forbidden = env === "production" ? PRODUCTION_FORBIDDEN : [];
    const { missing, forbiddenPresent } = envCheck({ required, forbidden, present });
    for (const name of missing) failures.push(`missing env var ${name} (${env})`);
    for (const name of forbiddenPresent) failures.push(`env var ${name} must not be set (${env})`);
    const soft = envCheck({ required: WARN_IF_MISSING, forbidden: [], present });
    for (const name of soft.missing) warnings.push(`env var ${name} is not set (${env}); email will not send`);
  }
}

try {
  const sqlFiles = readdirSync("drizzle").filter((f) => f.endsWith(".sql"));
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const mismatch = migrationTagMismatch(sqlFiles, journal.entries.map((e) => e.tag));
  if (mismatch) failures.push(mismatch);
} catch {
  failures.push("couldn't read drizzle/ or drizzle/meta/_journal.json");
}

if (env === "production") {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== "main") failures.push(`not on main (on ${branch || "unknown"})`);
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.stdout.trim() !== "") failures.push("working tree has uncommitted changes");
  if (!run("git", ["fetch", "--quiet", "origin", "main"]).ok) {
    failures.push("couldn't fetch origin/main");
  } else {
    const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    const remote = run("git", ["rev-parse", "origin/main"]).stdout.trim();
    if (!head || head !== remote) failures.push("HEAD is not origin/main");
  }
}

for (const line of warnings) console.log(`warn ${line}`);
for (const line of failures) console.log(`FAIL ${line}`);
if (failures.length === 0) console.log(`ok   predeploy checks passed (${env})`);
process.exit(failures.length === 0 ? 0 : 1);
