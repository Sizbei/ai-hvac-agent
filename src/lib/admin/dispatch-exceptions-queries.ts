/**
 * Exceptions rail — the queued auto-dispatch jobs a dispatcher needs to resolve.
 *
 * DELIBERATELY day-independent (unlike getDispatchBoard, which is bounded to the
 * selected day and requires a non-null arrival window). A queued job may have no
 * window yet and may have been queued yesterday, so it must not scroll out of
 * sight: this query filters on unassigned + auto_dispatch_outcome queued_* +
 * non-terminal status, oldest first, capped. Tenant-scoped.
 */
import { asc, isNull, like, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchException {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly autoDispatchOutcome: string;
  readonly createdAt: string;
}

const TERMINAL_STATUSES = ["completed", "cancelled"] as const;

export async function getDispatchExceptions(
  organizationId: string,
  limit = 20,
): Promise<readonly DispatchException[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      autoDispatchOutcome: serviceRequests.autoDispatchOutcome,
      createdAt: serviceRequests.createdAt,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        isNull(serviceRequests.assignedTo),
        like(serviceRequests.autoDispatchOutcome, "queued_%"),
        notInArray(serviceRequests.status, [...TERMINAL_STATUSES]),
      ),
    )
    .orderBy(asc(serviceRequests.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    referenceNumber: r.referenceNumber,
    issueType: r.issueType,
    urgency: r.urgency,
    autoDispatchOutcome: r.autoDispatchOutcome ?? "",
    createdAt: r.createdAt.toISOString(),
  }));
}
