/**
 * Pure helpers for the pre-deploy checklist (scripts/agent/predeploy-check.mjs).
 * They deal in env var NAMES; only `envValueCheck` reads a value cell, and it
 * returns a verdict, never the value.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names from `vercel env ls` output. The table starts at the header row
 * (`name  value  environments  created`); the first column of each later row
 * is the name. Banner, "found for" and blank lines are skipped. The value
 * column is never read.
 */
export function parseVercelEnvLs(stdout: string): string[] {
  return [...new Set(tableRows(stdout).map((cells) => cells[0]))];
}

/** The table rows (cells) after the `name … environments …` header. */
function tableRows(stdout: string): string[][] {
  const rows: string[][] = [];
  let inTable = false;
  for (const line of stdout.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells[0]?.toLowerCase() === "name" && cells.some((c) => c.toLowerCase() === "environments")) {
      inTable = true;
      continue;
    }
    if (inTable && ENV_NAME.test(cells[0] ?? "")) rows.push(cells);
  }
  return rows;
}

export type EnvValueVerdict = "missing" | "hidden" | "match" | "mismatch";

/**
 * Whether `name` is set to `expected` in `vercel env ls` output, as a verdict
 * only (the value is never returned). "hidden" when the CLI shows the value as
 * Encrypted (CLI 50 does for every variable), so it can't be checked here.
 */
export function envValueCheck(stdout: string, name: string, expected: string): EnvValueVerdict {
  const values = tableRows(stdout).filter((cells) => cells[0] === name).map((cells) => cells[1] ?? "");
  if (values.length === 0) return "missing";
  if (values.some((v) => v.toLowerCase() !== "encrypted" && v !== expected)) return "mismatch";
  return values.every((v) => v === expected) ? "match" : "hidden";
}

export function envCheck({
  required,
  forbidden,
  present,
}: {
  required: readonly string[];
  forbidden: readonly string[];
  present: readonly string[];
}): { missing: string[]; forbiddenPresent: string[] } {
  const have = new Set(present);
  return {
    missing: required.filter((name) => !have.has(name)),
    forbiddenPresent: forbidden.filter((name) => have.has(name)),
  };
}

/**
 * The newest `drizzle/*.sql` file must be the journal's last entry, or the
 * build's migrator would skip (or never see) a migration. Returns the reason
 * on mismatch, null when they agree.
 */
export function migrationTagMismatch(sqlFileNames: readonly string[], journalTags: readonly string[]): string | null {
  const newestFile = [...sqlFileNames].sort().at(-1)?.replace(/\.sql$/, "");
  const lastTag = journalTags.at(-1);
  if (!newestFile && !lastTag) return "no migrations found in drizzle/";
  if (newestFile === lastTag) return null;
  return `newest migration file ${newestFile ?? "(none)"} is not the last journal entry (${lastTag ?? "none"})`;
}
