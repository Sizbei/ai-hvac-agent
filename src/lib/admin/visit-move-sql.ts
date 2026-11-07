/**
 * Shared SQL for the M2 writers (spec §4.1, §5.3–§5.5). Pure builders: every
 * table reference binds organization_id as a parameter; every fragment holding
 * OR is parenthesised; enum literals are cast. "Correlated" builders refer to
 * the unaliased outer `"service_requests"` row (an UPDATE service_requests or a
 * drizzle query on serviceRequests), like visit-one-guard.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import { closeJobEntriesSql } from "@/lib/tech/time-entry-sql";
import { placedByVisitSql } from "./current-visit";
import { OPEN_STATUSES } from "./request-status";
import { anyTimestampSql, startedRowSql } from "./visit-started";

const statusList = (list: readonly string[]): SQL => sql.raw(list.map((s) => `'${s}'::request_status`).join(", "));
// Builders, not module constants: modules that mock drizzle-orm (tests/e2e/smoke.test.ts) import this file transitively.
const openRows = (): SQL => statusList(OPEN_ASSIGNMENT_STATUSES);
const openRequests = (): SQL => statusList(OPEN_STATUSES);
/** Statuses a lead change resets (spec §5.3 step 1) and the revive maps to `assigned` (step 3). */
export const resetFromSql = (): SQL => statusList(["en_route", "arrived", "in_progress", "on_hold"]);

/** The correlated request is not FieldPulse-mapped (spec §5.1: every FieldPulse refusal is a predicate). */
export const fieldpulseFreeSql = (): SQL => sql.raw(`"service_requests"."fieldpulse_job_id" IS NULL`);

/** Visit #1 of the request, as a uuid scalar subquery. */
export function visitOneIdSql(org: string, rid: string): SQL {
  return sql`(SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = ${rid}::uuid AND v1.organization_id = ${org}::uuid AND v1.appointment_number = 1)`;
}

/** THIS transaction wrote the request row: gates every statement after the move's UPDATE. */
export function requestXminGateSql(org: string, rid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM service_requests xr WHERE xr.id = ${rid}::uuid AND xr.organization_id = ${org}::uuid AND xr.xmin = pg_current_xact_id()::xid)`;
}

/** THIS transaction wrote visit #1 (the trigger bumped its version): the audit gate (M3c, equipment-writes.ts:89). */
export function visitOneXminGateSql(org: string, rid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointments xp WHERE xp.service_request_id = ${rid}::uuid AND xp.organization_id = ${org}::uuid AND xp.appointment_number = 1 AND xp.xmin = pg_current_xact_id()::xid)`;
}

/**
 * The revision gate (spec §4.1): the card's visit is #1 of this request in
 * this org at this version. The id matters because a new #1 starts at 0. A
 * null visit means the card saw no visit #1: none may exist now.
 */
export function versionGateSql(org: string, rid: string, visitId: string | null, version: number | null): SQL {
  if (visitId === null) {
    return sql`NOT EXISTS (SELECT 1 FROM appointments g WHERE g.service_request_id = ${rid}::uuid AND g.organization_id = ${org}::uuid AND g.appointment_number = 1)`;
  }
  return sql`EXISTS (SELECT 1 FROM appointments g WHERE g.id = ${visitId}::uuid AND g.organization_id = ${org}::uuid AND g.service_request_id = ${rid}::uuid AND g.appointment_number = 1 AND g.version = ${version ?? -1}::int)`;
}

/** Visit #1 is what the office shows (not a later visit, not a hold-ended visit) and not cancelled. Correlated. */
export function visitOneLiveSql(org: string): SQL {
  return sql`(NOT ${placedByVisitSql()} AND NOT EXISTS (SELECT 1 FROM appointments c1 WHERE c1.service_request_id = "service_requests"."id" AND c1.organization_id = ${org}::uuid AND c1.appointment_number = 1 AND c1.cancelled_at IS NOT NULL))`;
}

/** A started live row on visit #1 of the correlated request; `lead`: the lead row only (spec §3.2). */
export function startedOnVisitOneSql(org: string, which: "lead" | "any"): SQL {
  const lead = which === "lead" ? sql` AND sa.is_lead` : sql``;
  return sql`EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = "service_requests"."id" AND sp.organization_id = ${org}::uuid AND sa.organization_id = ${org}::uuid AND sp.appointment_number = 1${lead} AND ${startedRowSql("sa")})`;
}

/** A started live row on visit #1 belonging to anyone but `technicianId` (the reset arm: "no other live row is started"). */
export function otherStartedOnVisitOneSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = "service_requests"."id" AND sp.organization_id = ${org}::uuid AND sa.organization_id = ${org}::uuid AND sp.appointment_number = 1 AND sa.technician_id <> ${technicianId}::uuid AND ${startedRowSql("sa")})`;
}

/** `technicianId` has a completed row on visit #1 of the correlated request: they never become its lead (TECHNICIAN_DONE). */
export function leadDoneSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments d JOIN appointments dp ON dp.id = d.appointment_id WHERE dp.service_request_id = "service_requests"."id" AND dp.organization_id = ${org}::uuid AND d.organization_id = ${org}::uuid AND dp.appointment_number = 1 AND d.technician_id = ${technicianId}::uuid AND d.status = 'completed'::request_status)`;
}

/** In-write twin of activeTechnicianIds: an active technician of the org. */
export function activeTechnicianSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${technicianId}::uuid AND u.organization_id = ${org}::uuid AND u.role = 'technician' AND u.is_active)`;
}

/**
 * No checked technician has an open row on a live visit of ANOTHER open
 * request whose window overlaps [start, end) (half-open, as
 * checkScheduleConflict; lead ruling 5).
 */
export function noOverlapSql(
  org: string, rid: string, technicianIds: readonly string[], startIso: string, endIso: string, excludeRequestIds: readonly string[] = [],
): SQL {
  return sql`NOT EXISTS (SELECT 1 ${overlapFromWhereSql(org, rid, technicianIds, startIso, endIso, excludeRequestIds)})`;
}

/**
 * The FROM … WHERE shared by noOverlapSql (the in-write twin) and the move's
 * pre-read of the overlapping rows. `excludeRequestIds`: mass reschedule's
 * other candidates, which move in the same batch (plan v2, A MAJOR-1).
 */
export function overlapFromWhereSql(
  org: string, rid: string, technicianIds: readonly string[], startIso: string, endIso: string, excludeRequestIds: readonly string[] = [],
): SQL {
  const others = excludeRequestIds.length > 0 ? sql` AND cr.id <> ALL(${sql.param([...excludeRequestIds])}::uuid[])` : sql``;
  return sql`FROM appointment_assignments ca JOIN appointments cp ON cp.id = ca.appointment_id JOIN service_requests cr ON cr.id = cp.service_request_id
    WHERE ca.organization_id = ${org}::uuid AND cp.organization_id = ${org}::uuid AND cr.organization_id = ${org}::uuid
      AND ca.technician_id = ANY(${sql.param([...technicianIds])}::uuid[]) AND ca.status IN (${openRows()})
      AND cp.cancelled_at IS NULL AND cr.id <> ${rid}::uuid AND cr.status IN (${openRequests()})
      AND cp.arrival_window_start < ${endIso}::timestamptz AND cp.arrival_window_end > ${startIso}::timestamptz${others}`;
}

/**
 * Step 3: the new lead's row (a trigger insert, or an existing row the trigger
 * kept `cancelled`, 0050:134–145) starts clean: status = the request's status,
 * or `assigned` while the request is en route / on site / paused (someone
 * else's work); the four progress stamps nulled (spec §3.3 "revived rows start
 * clean"). The WHERE only matches a cancelled row or a started status with no
 * stamp, so a working helper promoted to lead keeps their progress.
 */
export function reviveLeadSql(org: string, rid: string, gate: SQL): SQL {
  return sql`UPDATE appointment_assignments a SET status = CASE WHEN r.status IN (${resetFromSql()}) THEN 'assigned'::request_status ELSE r.status END,
      en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL
    FROM service_requests r, appointments p
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      AND p.id = a.appointment_id AND p.service_request_id = r.id AND p.organization_id = ${org}::uuid AND p.appointment_number = 1
      AND a.organization_id = ${org}::uuid AND a.technician_id = r.assigned_to AND a.is_lead
      AND (a.status = 'cancelled'::request_status OR (a.status IN (${resetFromSql()}) AND NOT ${anyTimestampSql("a")}))
      AND (${gate})
    RETURNING a.id`;
}

/** Step 2: the trigger keeps a `completed` old lead as a helper (0050:125–133); M2 takes them off the crew too. */
export function cancelDoneOldLeadSql(org: string, rid: string, oldLeadId: string, gate: SQL): SQL {
  return sql`UPDATE appointment_assignments a SET status = 'cancelled'::request_status
    FROM appointments p
    WHERE p.id = a.appointment_id AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND p.appointment_number = 1
      AND a.organization_id = ${org}::uuid AND a.technician_id = ${oldLeadId}::uuid AND NOT a.is_lead
      AND a.status = 'completed'::request_status AND (${gate})
    RETURNING a.id`;
}

/** Step 4: the old lead's open job time on visit #1 (or with no visit link) stops. */
export function closeOldLeadEntriesSql(org: string, rid: string, oldLeadId: string, gate: SQL): SQL {
  return closeJobEntriesSql({
    organizationId: org,
    requestId: rid,
    technicianIds: [oldLeadId],
    gate: sql`(${gate}) AND (t.appointment_id = ${visitOneIdSql(org, rid)} OR t.appointment_id IS NULL)`,
  });
}

/** No job time on visit #1 of the correlated request, nor any with no visit link (spec §5.4 WORK_LOGGED). */
export function noWorkLoggedSql(org: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM technician_time_entries t WHERE t.organization_id = ${org}::uuid AND t.service_request_id = "service_requests"."id" AND t.kind = 'job' AND (t.appointment_id = (SELECT w1.id FROM appointments w1 WHERE w1.service_request_id = "service_requests"."id" AND w1.organization_id = ${org}::uuid AND w1.appointment_number = 1) OR t.appointment_id IS NULL))`;
}
