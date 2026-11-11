import { sql } from "drizzle-orm";
import { estimates } from "@/lib/db/schema";

/**
 * An estimate's real creation time: FieldPulse's created_at for imports, else
 * the row's. The FieldPulse import writes created_at into `createdAt` (keeping
 * the earliest) and keeps it out of `fieldpulse_data`, so the jsonb arm is
 * normally inert; it stays as a defence for rows whose jsonb still carries it.
 * The cast is guarded with `pg_input_is_valid` (Postgres 16+): this runs in
 * the Reports and estimates WHERE/ORDER BY, so one malformed or empty value
 * must fall through to `createdAt`, not fail the whole query.
 */
export const EFFECTIVE_CREATED_AT_SQL = sql`
  coalesce(
    CASE WHEN pg_input_is_valid(${estimates.fieldpulseData}->>'created_at', 'timestamp')
      THEN (${estimates.fieldpulseData}->>'created_at')::timestamp AT TIME ZONE 'UTC'
    END,
    ${estimates.createdAt}
  )
`;
