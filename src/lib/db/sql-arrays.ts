import { sql, type SQL } from "drizzle-orm";

/**
 * `ARRAY[$1::uuid, …]::uuid[]`; an empty list is `ARRAY[]::uuid[]`. Drizzle
 * expands a bare JS array in a `sql` template into a `($1, $2)` list, which
 * is not an array, so array parameters go through this.
 */
export function uuidArraySql(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
}
