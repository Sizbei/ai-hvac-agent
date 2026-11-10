/**
 * Pure helpers for the pre-deploy checklist (scripts/agent/predeploy-check.mjs).
 * They deal in env var NAMES only — no value is ever read or returned.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names from `vercel env ls` output. The table starts at the header row
 * (`name  value  environments  created`); the first column of each later row
 * is the name. Banner, "found for" and blank lines are skipped. The value
 * column is never read.
 */
export function parseVercelEnvLs(stdout: string): string[] {
  const names = new Set<string>();
  let inTable = false;
  for (const line of stdout.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells[0]?.toLowerCase() === "name" && cells.some((c) => c.toLowerCase() === "environments")) {
      inTable = true;
      continue;
    }
    if (inTable && ENV_NAME.test(cells[0] ?? "")) names.add(cells[0]);
  }
  return [...names];
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
