/**
 * FieldPulse/HCP-imported requests carry no per-request name, phone or
 * address: those live on the linked customers row. These correlated
 * subqueries read them (tenant-scoped) so the technician's list and job page
 * show who and where, the same fallback the office queries use.
 *
 * No `hidden_from_org` predicate, on purpose: hidden history is an office-view
 * concept and does not apply to the assignee. A technician sees the customer
 * of a job assigned to them even when that job or customer is hidden from the
 * office. The callers pin the row to the technician's own assignment, and
 * `src/lib/tech/` is allowlisted in visibility-coverage/permanent.json, so the
 * coverage gate will not flag a change here: keep it assignee-scoped.
 */
import { sql } from "drizzle-orm";
import { customers, serviceRequests } from "@/lib/db/schema";

function customerColumn(column: typeof customers.nameEncrypted | typeof customers.phoneEncrypted | typeof customers.addressEncrypted) {
  return sql<string | null>`(
    select ${column} from ${customers}
    where ${customers.id} = ${serviceRequests.customerId}
      and ${customers.organizationId} = ${serviceRequests.organizationId}
  )`;
}

export const customerNameFallbackSql = () => customerColumn(customers.nameEncrypted);
export const customerPhoneFallbackSql = () => customerColumn(customers.phoneEncrypted);
export const customerAddressFallbackSql = () => customerColumn(customers.addressEncrypted);
