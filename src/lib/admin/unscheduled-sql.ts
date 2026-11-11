import { inArray, isNull, or, type SQL } from "drizzle-orm";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { NEEDS_PLACEMENT_STATUSES } from "./request-status";

/**
 * The ONE "unscheduled" set: an open request (pending through in progress)
 * with no technician or no arrival window. The nav badge and the dispatch
 * link (countUnscheduledRequests), the calendar page's panel
 * (getSchedulingCalendar) and listUnscheduledRequests all filter with this,
 * so the count always equals the rail's length. Tenant-scoped.
 *
 * `visible` is the caller's `visibleRows(serviceRequests, vis)`, passed in so
 * each read site still names its visibility filter (visibility-coverage gate).
 */
export function needsPlacementWhere(organizationId: string, visible: SQL): SQL {
  return withTenant(
    serviceRequests,
    organizationId,
    inArray(serviceRequests.status, [...NEEDS_PLACEMENT_STATUSES]),
    or(isNull(serviceRequests.assignedTo), isNull(serviceRequests.arrivalWindowStart))!,
    visible,
  );
}
