/**
 * Deterministic "technician running behind" detection (arrival lateness).
 *
 * A job is BEHIND when its arrival window has passed (plus a grace buffer) and the
 * tech still hasn't started it — i.e. status is still scheduled/assigned, not
 * in_progress/completed. This needs no travel model or live location (those only
 * sharpen it later), so it works today against arrival_window_end. Pure detection
 * is unit-tested; the org query + SMS live alongside.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

// Statuses that mean the tech has NOT yet arrived/started — only these can be
// "behind". in_progress/completed/cancelled are excluded (already there / done).
const NOT_STARTED_STATUSES = ["scheduled", "assigned"] as const;

/** True when the job's arrival window passed (by more than the grace) and the
 * tech hasn't started it yet. Pure. */
export function isArrivalLate(
  job: { readonly status: string; readonly arrivalWindowEnd: Date | null },
  nowMs: number,
  graceMinutes: number,
): boolean {
  if (!job.arrivalWindowEnd) return false;
  if (!(NOT_STARTED_STATUSES as readonly string[]).includes(job.status)) {
    return false;
  }
  return nowMs > job.arrivalWindowEnd.getTime() + graceMinutes * 60_000;
}

export interface LateJob {
  readonly id: string;
  readonly referenceNumber: string;
  readonly technicianName: string | null;
  readonly arrivalWindowEnd: Date;
}

/** Jobs in this org whose tech is running behind their arrival window. */
export async function findLateJobsForOrg(
  organizationId: string,
  now: Date,
  graceMinutes: number,
): Promise<LateJob[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      technicianName: users.name,
    })
    .from(serviceRequests)
    .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          inArray(serviceRequests.status, [...NOT_STARTED_STATUSES]),
          isNotNull(serviceRequests.arrivalWindowEnd),
        )!,
      ),
    );

  return rows
    .filter((r) => isArrivalLate(r, now.getTime(), graceMinutes))
    .map((r) => ({
      id: r.id,
      referenceNumber: r.referenceNumber,
      technicianName: r.technicianName,
      arrivalWindowEnd: r.arrivalWindowEnd!,
    }));
}
