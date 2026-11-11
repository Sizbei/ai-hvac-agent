/**
 * Go-live audit cutoff (P8 M7): a pure builder that stores the go-live moment
 * as `organizations.feature_flags.historyCutoff`. It merges with `||`, so the
 * boolean switches beside it are untouched. Run it in the same batch as the
 * marking (`scripts/agent/golive-hide-history.mjs --apply`), or on its own via
 * `scripts/agent/set-history-cutoff.mjs`.
 */
import { sql, type SQL } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UPDATE … RETURNING history_cutoff. Throws on a non-uuid org or an unparseable timestamp. */
export function historyCutoffPatchSql(org: string, iso: string): SQL {
  if (!UUID.test(org)) throw new Error("historyCutoffPatchSql: org must be a uuid");
  const at = new Date(iso);
  if (iso.trim() === "" || Number.isNaN(at.getTime())) {
    throw new Error("historyCutoffPatchSql: at must be an ISO timestamp");
  }
  return sql`UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object('historyCutoff', ${at.toISOString()}::text) WHERE id = ${org}::uuid RETURNING feature_flags->>'historyCutoff' AS history_cutoff`;
}
