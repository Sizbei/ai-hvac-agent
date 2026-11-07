/**
 * Visit #1 guards for the admin writers that rewrite the request's schedule or
 * lead (assign, reassign, schedule, place, unschedule, move). The trigger
 * mirrors those columns onto visit #1, so once a technician has started it, or
 * a hold has ended it, the office must work through Move… or the Visits section.
 * Two rules (M2 spec §3.2): `visitOneGuardSql` (timestamps; the sheet's schedule
 * edit, unchanged) and `visitOneStartedGuardSql` (the started rule; assign,
 * reassign, place, unschedule). The SQL goes into each writer's guarded UPDATE
 * (atomic); the classifier is the re-read after a 0-row update.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import { FIELDPULSE_SHEET_STARTED, SHEET_STARTED_NATIVE, UNSCHEDULE_COPY } from "./dispatch-copy";
import type { RequestStatus } from "./request-status";
import { leadDoneSql, startedOnVisitOneSql } from "./visit-move-sql";

export type VisitOneRefusal = "has_progress" | "visit_ended";
export type VisitOneRule = "timestamp" | "started";

// Literal qualified names, not column objects: Drizzle renders a column in a
// select list unqualified ("id"), which inside these subqueries would be
// ambiguous or bind to the inner table.

const progressed = () => sql<boolean>`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))`;

const ended = () => sql<boolean>`EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL)`;

/**
 * Run a guarded service_requests UPDATE after locking the request row, in one
 * batch, followed by `after` statements (e.g. reviveLeadSql, gated on the
 * request's xmin). Under READ COMMITTED a lone UPDATE that waits on the row lock
 * re-checks only the target row; its NOT EXISTS subqueries keep the snapshot
 * taken before the wait. Locking first gives the UPDATE a fresh snapshot.
 */
export async function lockedUpdate<T>(organizationId: string, requestId: string, update: T, after: readonly SQL[] = []): Promise<Awaited<T>> {
  const lock = db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`);
  const results = (await db.batch([lock, update, ...after.map((q) => db.execute(q))] as never)) as unknown as readonly unknown[];
  return results[1] as Awaited<T>;
}

/** Timestamp rule (unchanged): no progress stamp on visit #1, and #1 not ended. Parenthesised: it contains OR. */
export function visitOneGuardSql(): SQL {
  return sql`(NOT ${progressed()} AND ("service_requests"."status" = 'cancelled'::request_status OR NOT ${ended()}))`;
}

/** Started rule (M2 §3.2): no started live row on visit #1, and #1 not ended. */
export function visitOneStartedGuardSql(organizationId: string): SQL {
  return sql`(NOT ${startedOnVisitOneSql(organizationId, "any")} AND ("service_requests"."status" = 'cancelled'::request_status OR NOT ${ended()}))`;
}

/**
 * Re-read after a 0-row update: the request's status, which visit #1 guard
 * (if any) refuses it under `rule`, whether FieldPulse owns it, and whether
 * `technicianId` is done on visit #1.
 */
export async function classifyVisitOne(
  organizationId: string,
  requestId: string,
  rule: VisitOneRule = "timestamp",
  technicianId?: string,
): Promise<{ status: RequestStatus; refusal: VisitOneRefusal | null; fieldpulse: boolean; technicianDone: boolean } | null> {
  const [row] = await db
    .select({
      status: serviceRequests.status,
      progressed: rule === "started" ? sql<boolean>`${startedOnVisitOneSql(organizationId, "any")}` : progressed(),
      ended: ended(),
      fieldpulse: sql<boolean>`("service_requests"."fieldpulse_job_id" IS NOT NULL)`,
      technicianDone: technicianId ? sql<boolean>`${leadDoneSql(organizationId, technicianId)}` : sql<boolean>`false`,
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  if (!row) return null;
  const refusal: VisitOneRefusal | null = row.progressed
    ? "has_progress"
    : row.ended && row.status !== "cancelled" ? "visit_ended" : null;
  return { status: row.status, refusal, fieldpulse: row.fieldpulse === true, technicianDone: row.technicianDone === true };
}

/** True when the request is FieldPulse-mapped (for refusal copy on paths whose writer doesn't report it). */
export async function isFieldpulseMapped(organizationId: string, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ fp: serviceRequests.fieldpulseJobId })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  return Boolean(row?.fp);
}

/** 409 for a visit #1 refusal. FieldPulse first (spec §5.5): a FieldPulse request's refusal names FieldPulse. */
export function visitOneRefusalResponse(
  reason: VisitOneRefusal,
  opts: { readonly fieldpulse?: boolean; readonly surface?: "sheet" | "unschedule" } = {},
) {
  if (reason === "visit_ended") {
    return errorResponse("This visit has ended. Add a new visit instead.", "VISIT_ENDED", 409);
  }
  const message = opts.fieldpulse
    ? FIELDPULSE_SHEET_STARTED
    : opts.surface === "unschedule" ? UNSCHEDULE_COPY.HAS_PROGRESS : SHEET_STARTED_NATIVE;
  return errorResponse(message, "HAS_PROGRESS", 409);
}
