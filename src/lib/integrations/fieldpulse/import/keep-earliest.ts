import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * SET-clause value for a created_at column on a FieldPulse re-sync: the earlier
 * of the stored value and FieldPulse's own created date (see earlierFpDate in
 * ../fp-dates.ts). Rows first stamped with the import day move back to the real
 * date; nothing ever moves later. Touches only created_at, which no unhide
 * trigger watches.
 */
export function keepEarliest(column: AnyColumn, fpCreatedAt: Date): SQL {
  return sql`LEAST(${column}, ${fpCreatedAt.toISOString()}::timestamptz)`;
}

/**
 * SET-clause value for is_after_hours next to keepEarliest: when FieldPulse's
 * date moves created_at earlier, the flag is recomputed for that real booking
 * time (`afterHoursAtFp`, computed by the caller from the org's config);
 * otherwise the stored flag stays. SET reads the row's old values, so the
 * comparison sees the created_at from before this UPDATE.
 */
export function afterHoursIfMovedEarlier(
  createdAt: AnyColumn,
  isAfterHours: AnyColumn,
  fpCreatedAt: Date,
  afterHoursAtFp: boolean,
): SQL {
  return sql`CASE WHEN ${fpCreatedAt.toISOString()}::timestamptz < ${createdAt} THEN ${afterHoursAtFp} ELSE ${isAfterHours} END`;
}
