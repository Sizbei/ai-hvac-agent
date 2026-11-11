/**
 * Shared by the go-live data scripts (golive-hide-history, golive-hide-junk,
 * golive-polish-defaults, fp-truth-backfill, fp-hide-deleted-jobs).
 *
 * Environment: .env.local is the DEV branch. It fills missing variables only
 * when DATABASE_URL is not already in the environment and the run is not
 * --prod. A run against any other database therefore takes EVERY value from
 * the environment, so a prod run can never pick up the DEV FieldPulse key or
 * the DEV encryption key from .env.local.
 *
 * Undo records: kept in ~/.hvac-golive/, outside the repo (never committed)
 * and outside the OS temp dir (which gets purged).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROD_HOST = "ep-withered-hill";
export const GOLIVE_DIR = join(homedir(), ".hvac-golive");

function refuse(reason) {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

/**
 * Load the environment, then return DATABASE_URL. `keys` limits which .env.local
 * variables are read (null = all). Refuses a --prod run without an exported
 * DATABASE_URL, and a prod URL without --prod. Call before importing any
 * database module.
 */
export function loadGoliveEnv({ prod, keys = null }) {
  if (prod && !process.env.DATABASE_URL) {
    refuse("--prod needs DATABASE_URL (and the other values the script uses) exported in the environment; .env.local is the DEV branch and is not read for --prod");
  }
  if (!process.env.DATABASE_URL && !prod && existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      if (keys && !keys.includes(m[1])) continue;
      process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) refuse("DATABASE_URL is not set");
  // Hostnames are case-insensitive: match the production host in any letter case.
  if (url.toLowerCase().includes(PROD_HOST) && !prod) refuse("this is the production database; pass --prod to run against it");
  return url;
}

/** Absolute path for an undo record in ~/.hvac-golive/ (created 0700 on first use). */
export function goliveRecordPath(name) {
  mkdirSync(GOLIVE_DIR, { recursive: true, mode: 0o700 });
  return join(GOLIVE_DIR, name);
}
