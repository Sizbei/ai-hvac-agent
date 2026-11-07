import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import { activeTechnicianIds, anyTimeOff, getAppointment } from "./appointment-queries";
import { MAX_TECHNICIANS_PER_VISIT, type AppointmentRecord } from "./appointment-types";
import { BUSINESS_TIME_ZONE, businessDayBounds, businessIsoDate } from "./calendar-time";
import { anyTimestampSql, startedRowSql } from "./visit-started";

// Helpers on ANY visit (including #1): add or remove a technician on a visit.
// Visit #1's lead is owned by the request->visit trigger; these writes only
// touch non-lead rows. neon-http: one db.batch = one implicit transaction.

export type AddVisitTechnicianResult =
  | AppointmentRecord
  | {
      readonly reason:
        | "not_found" | "technician_not_found" | "already_assigned" | "visit_cancelled"
        | "visit_ended" | "request_cancelled" | "request_completed" | "time_off" | "managed_externally"
        | "no_lead" | "visit_full";
    };

export type RemoveVisitTechnicianResult =
  /** `cancelled`: the helper had progress stamps but wasn't working, so the row was kept as cancelled (M2 §3.3). */
  | { readonly ok: true; readonly cancelled: boolean }
  | {
      readonly reason:
        | "not_found" | "has_progress" | "is_lead"
        | "managed_externally" | "request_completed" | "request_cancelled";
    };

type Visit = AppointmentRecord;

/** The window time off is checked against: the visit's span, else its business day, else none. */
function visitWindow(visit: Visit): { start: Date; end: Date } | null {
  const start = visit.startsAt ?? visit.arrivalWindowStart;
  const end = visit.endsAt ?? visit.arrivalWindowEnd;
  if (start && end) return { start: new Date(start), end: new Date(end) };
  if (visit.scheduledDate) {
    return businessDayBounds(businessIsoDate(new Date(visit.scheduledDate)));
  }
  return null;
}

/**
 * In-write twin of noTimeOff: the window is read from the appointments row `p`
 * inside the same statement (span, else arrival window, else the business day),
 * so a concurrent visit move cannot slip past a JS-side pre-read. No window
 * (all NULL) means no check.
 */
export function noTimeOffForVisit(organizationId: string, technicianId: string, appointmentId: string): SQL {
  const day = sql`((p.scheduled_date AT TIME ZONE ${BUSINESS_TIME_ZONE})::date)`;
  const start = sql`COALESCE(p.starts_at, p.arrival_window_start, (${day})::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE})`;
  const end = sql`COALESCE(p.ends_at, p.arrival_window_end, (${day} + 1)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE})`;
  return sql`NOT EXISTS (SELECT 1 FROM appointments p JOIN technician_shifts s ON s.organization_id = ${organizationId}::uuid
    WHERE p.id = ${appointmentId}::uuid AND s.technician_id = ${technicianId}::uuid AND s.removes_capacity
      AND s.starts_at < ${end} AND s.ends_at > ${start})`;
}

// Constants, not user input: inlined with enum casts so the IN list is typed.
const OPEN_LIST = sql.raw(OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'::request_status`).join(", "));

export async function addVisitTechnician(
  organizationId: string,
  requestId: string,
  appointmentId: string,
  technicianId: string,
  actorUserId: string,
): Promise<AddVisitTechnicianResult> {
  const visit = await getAppointment(organizationId, requestId, appointmentId);
  if (!visit) return { reason: "not_found" };
  if ((await activeTechnicianIds(organizationId, [technicianId])).length !== 1) {
    return { reason: "technician_not_found" };
  }
  const window = visitWindow(visit);

  // The request row is locked FOR NO KEY UPDATE first (M2 §3.3: two adds can't
  // both see four), so a concurrent cancel/complete/move either commits before
  // the statement's checks run, or waits for this batch. One statement inserts
  // (or revives a cancelled non-lead row clean) and bumps the visit's version
  // only when a row was written, so a stale board card answers STALE.
  const org = sql`${organizationId}::uuid`;
  const aid = sql`${appointmentId}::uuid`;
  const [, inserted] = await db.batch([
    db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`),
    db.execute(sql`WITH ins AS (INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_by)
      SELECT ${org}, ${aid}, ${technicianId}::uuid, false, 'assigned'::request_status, ${actorUserId}::uuid
      WHERE EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${requestId}::uuid AND r.organization_id = ${org}
          AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))
        AND EXISTS (SELECT 1 FROM appointments p WHERE p.id = ${aid} AND p.service_request_id = ${requestId}::uuid
          AND p.organization_id = ${org} AND p.cancelled_at IS NULL)
        AND EXISTS (SELECT 1 FROM appointment_assignments x WHERE x.appointment_id = ${aid} AND x.organization_id = ${org} AND x.status IN (${OPEN_LIST}))
        AND EXISTS (SELECT 1 FROM appointment_assignments l WHERE l.appointment_id = ${aid} AND l.organization_id = ${org} AND l.is_lead AND l.status <> 'cancelled'::request_status)
        AND (SELECT count(*) FROM appointment_assignments c WHERE c.appointment_id = ${aid} AND c.organization_id = ${org} AND c.status <> 'cancelled'::request_status AND c.technician_id <> ${technicianId}::uuid) < ${MAX_TECHNICIANS_PER_VISIT}::int
        AND ${noTimeOffForVisit(organizationId, technicianId, appointmentId)}
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = 'assigned'::request_status, assigned_by = EXCLUDED.assigned_by, assigned_at = now(),
        en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL
        WHERE appointment_assignments.status = 'cancelled'::request_status AND NOT appointment_assignments.is_lead
      RETURNING id),
    bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = ${aid} AND organization_id = ${org} AND EXISTS (SELECT 1 FROM ins) RETURNING id)
    SELECT id FROM ins`),
  ]);
  if (inserted.rows.length === 0) return classifyAddMiss(organizationId, requestId, appointmentId, technicianId, window);

  const record = await getAppointment(organizationId, requestId, appointmentId);
  if (!record) throw new Error("Visit vanished after assignment insert");
  return record;
}

/** Why the guarded INSERT matched nothing (re-read after the fact). */
async function classifyAddMiss(
  organizationId: string, requestId: string, appointmentId: string, technicianId: string,
  window: { start: Date; end: Date } | null,
): Promise<{ readonly reason: Exclude<AddVisitTechnicianResult, AppointmentRecord>["reason"] }> {
  const [req] = await db.select({
    status: serviceRequests.status, fp: serviceRequests.fieldpulseJobId, hcp: serviceRequests.hcpJobId,
  }).from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId))).limit(1);
  const visit = await getAppointment(organizationId, requestId, appointmentId);
  if (!req || !visit) return { reason: "not_found" };
  if (visit.cancelledAt !== null) return { reason: "visit_cancelled" };
  if (req.status === "cancelled") return { reason: "request_cancelled" };
  if (req.status === "completed") return { reason: "request_completed" };
  if (req.fp !== null || req.hcp !== null) return { reason: "managed_externally" };
  const live = visit.assignments.filter((a) => a.status !== "cancelled");
  if (live.some((a) => a.technicianId === technicianId)) return { reason: "already_assigned" };
  const hasOpen = visit.assignments.some((a) => (OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status));
  if (visit.assignments.length > 0 && !hasOpen) return { reason: "visit_ended" };
  if (!live.some((a) => a.isLead)) return { reason: "no_lead" };
  if (live.filter((a) => a.technicianId !== technicianId).length >= MAX_TECHNICIANS_PER_VISIT) return { reason: "visit_full" };
  if (window && (await anyTimeOff(organizationId, [technicianId], window.start, window.end))) {
    return { reason: "time_off" };
  }
  // State moved between the INSERT and this re-read; the caller can simply retry.
  return { reason: "not_found" };
}

export async function removeVisitTechnician(
  organizationId: string,
  requestId: string,
  appointmentId: string,
  technicianId: string,
): Promise<RemoveVisitTechnicianResult> {
  // One batch: request lock, then ONE statement — an untouched helper is
  // deleted (today), a helper with progress stamps who isn't working is kept
  // as cancelled (M2 §3.3), and the visit's version bumps when either landed.
  // A working (started) helper matches neither: has_progress below.
  const org = sql`${organizationId}::uuid`;
  const rowOnVisit = sql`a.appointment_id = p.id AND p.id = ${appointmentId}::uuid AND p.service_request_id = ${requestId}::uuid
      AND p.organization_id = ${org} AND a.organization_id = ${org}
      AND a.technician_id = ${technicianId}::uuid AND NOT a.is_lead
      AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.organization_id = ${org}
        AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))`;
  const [, written] = await db.batch([
    db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`),
    db.execute(sql`WITH del AS (DELETE FROM appointment_assignments a USING appointments p
        WHERE ${rowOnVisit} AND a.status <> 'cancelled'::request_status AND NOT ${anyTimestampSql("a")}
        RETURNING a.id),
      can AS (UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p
        WHERE ${rowOnVisit} AND a.status <> 'cancelled'::request_status AND ${anyTimestampSql("a")} AND NOT ${startedRowSql("a")}
        RETURNING a.id),
      bump AS (UPDATE appointments SET version = version + 1, updated_at = now()
        WHERE id = ${appointmentId}::uuid AND organization_id = ${org} AND (EXISTS (SELECT 1 FROM del) OR EXISTS (SELECT 1 FROM can)) RETURNING id)
      SELECT (SELECT count(*) FROM del)::int AS deleted, (SELECT count(*) FROM can)::int AS cancelled`),
  ]);
  const counts = (written.rows[0] ?? {}) as { deleted?: number; cancelled?: number };
  if (Number(counts.deleted ?? 0) > 0) return { ok: true, cancelled: false };
  if (Number(counts.cancelled ?? 0) > 0) return { ok: true, cancelled: true };

  // Why the guarded DELETE matched nothing (re-read after the fact, request first like add).
  const [req] = await db.select({
    status: serviceRequests.status, fp: serviceRequests.fieldpulseJobId, hcp: serviceRequests.hcpJobId,
  }).from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId))).limit(1);
  if (!req) return { reason: "not_found" };
  if (req.fp !== null || req.hcp !== null) return { reason: "managed_externally" };
  if (req.status === "completed") return { reason: "request_completed" };
  if (req.status === "cancelled") return { reason: "request_cancelled" };

  const [row] = await db.select({ isLead: appointmentAssignments.isLead, status: appointmentAssignments.status }).from(appointmentAssignments)
    .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
    .where(withTenant(appointmentAssignments, organizationId,
      and(eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId),
        eq(appointmentAssignments.technicianId, technicianId))!)).limit(1);
  if (!row || row.status === "cancelled") return { reason: "not_found" };
  if (row.isLead) return { reason: "is_lead" };
  return { reason: "has_progress" };
}
