import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Hidden-history visibility. Imported history rows carry `hidden_from_org`;
 * org users don't see them unless the org turns on `showHistory`. The platform
 * owner (not previewing) sees everything. Pure: no DB, no session.
 */
export interface Visibility {
  readonly showHidden: boolean;
}

/** Crons, the AI and writers: they act on every row, hidden or not. */
export const SHOW_ALL: Visibility = Object.freeze({ showHidden: true });

/** What an org user sees without `showHistory`. */
export const VISIBLE_ONLY: Visibility = Object.freeze({ showHidden: false });

const SAFE_ALIAS = /^[a-z][a-z0-9_]*$/;

/** Drizzle predicate: `true`, or `<table>.hidden_from_org = false`. */
export function visibleRows(
  table: { hiddenFromOrg: AnyPgColumn },
  vis: Visibility,
): SQL {
  return vis.showHidden ? sql`true` : eq(table.hiddenFromOrg, false);
}

/**
 * Raw-SQL predicate on a table alias: `TRUE`, or `<alias>.hidden_from_org = false`.
 * The alias is spliced in as raw SQL, so anything but a lowercase identifier throws.
 */
export function visibleRowsSql(alias: string, vis: Visibility): SQL {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error("visibleRowsSql: alias must be a lowercase SQL identifier");
  }
  return vis.showHidden ? sql.raw("TRUE") : sql.raw(`${alias}.hidden_from_org = false`);
}

/** Platform owner (not previewing) sees everything; `showHistory` reveals history to the org. */
export function computeShowHidden(p: {
  isPlatformAdmin: boolean;
  previewing: boolean;
  showHistory: boolean;
}): boolean {
  return (p.isPlatformAdmin && !p.previewing) || p.showHistory;
}
