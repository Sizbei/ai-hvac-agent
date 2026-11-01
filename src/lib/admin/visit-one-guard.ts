/**
 * Visit #1 guards for the admin writers that rewrite the request's schedule or
 * lead (assign, reassign, schedule, place, unschedule). The trigger mirrors
 * those columns onto visit #1, so once a technician has started it, or a hold
 * has ended it, the office must work through the Visits section instead.
 * The SQL goes into each writer's guarded UPDATE (atomic); the classifier is
 * the re-read after a 0-row update.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import type { RequestStatus } from "./request-status";

export type VisitOneRefusal = "has_progress" | "visit_ended";

// Literal qualified names, not column objects: Drizzle renders a column in a
// select list unqualified ("id"), which inside these subqueries would be
// ambiguous or bind to the inner table.

const progressed = () => sql<boolean>`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))`;

const ended = () => sql<boolean>`EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL)`;

/**
 * Run a guarded service_requests UPDATE after locking the request row, in one
 * batch. Under READ COMMITTED a lone UPDATE that waits on the row lock
 * re-checks only the target row; its NOT EXISTS subqueries keep the snapshot
 * taken before the wait. Locking first gives the UPDATE a fresh snapshot.
 */
export async function lockedUpdate<T>(organizationId: string, requestId: string, update: T): Promise<Awaited<T>> {
  const lock = db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`);
  const results = (await db.batch([lock, update] as never)) as unknown as readonly unknown[];
  return results[1] as Awaited<T>;
}

/** Both guards for a service_requests UPDATE. Parenthesised: it contains OR. */
export function visitOneGuardSql(): SQL {
  return sql`(NOT ${progressed()} AND ("service_requests"."status" = 'cancelled'::request_status OR NOT ${ended()}))`;
}

/** Re-read after a 0-row update: the request's status and which visit #1 guard (if any) refuses it. */
export async function classifyVisitOne(
  organizationId: string,
  requestId: string,
): Promise<{ status: RequestStatus; refusal: VisitOneRefusal | null } | null> {
  const [row] = await db
    .select({ status: serviceRequests.status, progressed: progressed(), ended: ended() })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  if (!row) return null;
  const refusal: VisitOneRefusal | null = row.progressed
    ? "has_progress"
    : row.ended && row.status !== "cancelled" ? "visit_ended" : null;
  return { status: row.status, refusal };
}

export function visitOneRefusalResponse(reason: VisitOneRefusal) {
  return reason === "has_progress"
    ? errorResponse("A technician has already started this visit.", "HAS_PROGRESS", 409)
    : errorResponse("This visit has ended. Add a new visit instead.", "VISIT_ENDED", 409);
}
