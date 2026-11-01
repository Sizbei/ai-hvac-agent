import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import { activeTechnicianIds, anyTimeOff, getAppointment, noTimeOff } from "./appointment-queries";
import type { AppointmentRecord } from "./appointment-types";
import { businessDayBounds, businessIsoDate } from "./calendar-time";

// Helpers on ANY visit (including #1): add or remove a technician on a visit.
// Visit #1's lead is owned by the request->visit trigger; these writes only
// touch non-lead rows. neon-http: one db.batch = one implicit transaction.

export type AddVisitTechnicianResult =
  | AppointmentRecord
  | {
      readonly reason:
        | "not_found" | "technician_not_found" | "already_assigned" | "visit_cancelled"
        | "visit_ended" | "request_cancelled" | "request_completed" | "time_off";
    };

export type RemoveVisitTechnicianResult =
  | { readonly ok: true }
  | { readonly reason: "not_found" | "has_progress" | "is_lead" };

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
  const timeOffOk = window
    ? noTimeOff(organizationId, [technicianId], window.start.toISOString(), window.end.toISOString())
    : sql`TRUE`;

  // The request row is locked FOR SHARE first (a concurrent cancel/complete either
  // commits before the INSERT's checks run, or waits for this batch); the checks
  // are in the INSERT so they see the post-lock snapshot.
  const [, inserted] = await db.batch([
    db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR SHARE`),
    db.execute(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_by)
      SELECT ${organizationId}::uuid, ${appointmentId}::uuid, ${technicianId}::uuid, false, 'assigned'::request_status, ${actorUserId}::uuid
      WHERE EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${requestId}::uuid AND r.organization_id = ${organizationId}::uuid
          AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))
        AND EXISTS (SELECT 1 FROM appointments p WHERE p.id = ${appointmentId}::uuid AND p.service_request_id = ${requestId}::uuid
          AND p.organization_id = ${organizationId}::uuid AND p.cancelled_at IS NULL)
        AND (NOT EXISTS (SELECT 1 FROM appointment_assignments x WHERE x.appointment_id = ${appointmentId}::uuid)
          OR EXISTS (SELECT 1 FROM appointment_assignments x WHERE x.appointment_id = ${appointmentId}::uuid
            AND x.status IN (${OPEN_LIST})))
        AND ${timeOffOk}
      ON CONFLICT (appointment_id, technician_id) DO NOTHING
      RETURNING id`),
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
  if (req.fp !== null || req.hcp !== null) return { reason: "not_found" };
  if (visit.assignments.some((a) => a.technicianId === technicianId)) return { reason: "already_assigned" };
  const hasOpen = visit.assignments.some((a) => (OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status));
  if (visit.assignments.length > 0 && !hasOpen) return { reason: "visit_ended" };
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
  const deleted = await db.execute(sql`DELETE FROM appointment_assignments a USING appointments p
    WHERE a.appointment_id = p.id AND p.id = ${appointmentId}::uuid AND p.service_request_id = ${requestId}::uuid
      AND p.organization_id = ${organizationId}::uuid AND a.organization_id = ${organizationId}::uuid
      AND a.technician_id = ${technicianId}::uuid AND NOT a.is_lead
      AND a.en_route_at IS NULL AND a.arrived_at IS NULL AND a.started_at IS NULL AND a.completed_at IS NULL
    RETURNING a.id`);
  if (deleted.rows.length > 0) return { ok: true };

  const [row] = await db.select({ isLead: appointmentAssignments.isLead }).from(appointmentAssignments)
    .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
    .where(withTenant(appointmentAssignments, organizationId,
      and(eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId),
        eq(appointmentAssignments.technicianId, technicianId))!)).limit(1);
  if (!row) return { reason: "not_found" };
  if (row.isLead) return { reason: "is_lead" };
  return { reason: "has_progress" };
}
