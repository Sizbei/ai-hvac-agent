import { eq, and, SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

type TableWithOrgId = PgTable & {
  organizationId: PgColumn;
};

/**
 * Creates a SQL condition that enforces multi-tenancy by filtering on organization_id.
 * Every database query MUST use this helper to prevent cross-tenant data access.
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(customerSessions)
 *   .where(withTenant(customerSessions, orgId, eq(customerSessions.status, 'chatting')));
 * ```
 */
export function withTenant<T extends TableWithOrgId>(
  table: T,
  organizationId: string,
  ...conditions: SQL[]
): SQL {
  const orgFilter = eq(table.organizationId, organizationId);
  if (conditions.length === 0) {
    return orgFilter;
  }
  return and(orgFilter, ...conditions)!;
}
