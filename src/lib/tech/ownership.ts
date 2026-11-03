/**
 * Technician job ownership. A technician owns a job through assignment rows on
 * its non-cancelled visits (appointment_assignments), not only through
 * service_requests.assigned_to. This module is the ONE place the rule lives:
 * pure pickers, the queries behind them, and the EXISTS fragment for set queries.
 */
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { RequestStatus } from "@/lib/admin/request-status";

export const OPEN_ASSIGNMENT_STATUSES = [
  "assigned", "scheduled", "en_route", "arrived", "in_progress", "on_hold",
] as const;

export interface TechAssignmentRow {
  readonly assignmentId: string;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly isLead: boolean;
  readonly status: RequestStatus;
  readonly cancelledAt: Date | null;
  readonly enRouteAt: Date | null;
  readonly arrivedAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly technicianId: string;
}

export interface ActiveVisit {
  readonly appointmentId: string;
  readonly leadTechnicianId: string | null;
}

export function hasProgress(
  r: Pick<TechAssignmentRow, "enRouteAt" | "arrivedAt" | "startedAt" | "completedAt">,
): boolean {
  return r.enRouteAt !== null || r.arrivedAt !== null || r.startedAt !== null || r.completedAt !== null;
}

export function isOpen(status: RequestStatus): boolean {
  return (OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

const byNumber = (a: TechAssignmentRow, b: TechAssignmentRow): number => a.appointmentNumber - b.appointmentNumber;

/**
 * The visit the request is "on": the earliest non-cancelled visit with an open
 * row; else the latest non-cancelled visit that still has a non-cancelled row.
 * `rows` = every assignment row of the request (all technicians).
 */
export function pickActiveVisit(rows: readonly TechAssignmentRow[]): ActiveVisit | null {
  const live = rows.filter((r) => r.cancelledAt === null).slice().sort(byNumber);
  const pick = live.find((r) => isOpen(r.status))
    ?? [...live].reverse().find((r) => r.status !== "cancelled");
  if (!pick) return null;
  const lead = live.find((r) => r.appointmentId === pick.appointmentId && r.isLead && r.status !== "cancelled");
  return { appointmentId: pick.appointmentId, leadTechnicianId: lead?.technicianId ?? null };
}

/** The caller's row to act on (see brief): active visit row, else earliest open, else latest non-cancelled. */
export function pickActiveAssignment(
  mine: readonly TechAssignmentRow[],
  activeVisitId: string | null,
): TechAssignmentRow | null {
  const sorted = mine.slice().sort(byNumber);
  const onActive = activeVisitId === null ? undefined : sorted.find((r) => r.appointmentId === activeVisitId);
  return onActive
    ?? sorted.find((r) => isOpen(r.status))
    ?? [...sorted].reverse().find((r) => r.status !== "cancelled")
    ?? null;
}

// A function, not a constant: modules that partially mock the schema import this file transitively.
const assignmentColumns = () => ({
  assignmentId: appointmentAssignments.id,
  appointmentId: appointmentAssignments.appointmentId,
  appointmentNumber: appointments.appointmentNumber,
  isLead: appointmentAssignments.isLead,
  status: appointmentAssignments.status,
  cancelledAt: appointments.cancelledAt,
  enRouteAt: appointmentAssignments.enRouteAt,
  arrivedAt: appointmentAssignments.arrivedAt,
  startedAt: appointmentAssignments.startedAt,
  completedAt: appointmentAssignments.completedAt,
  technicianId: appointmentAssignments.technicianId,
});

/** Every technician's rows on the request's non-cancelled visits, by visit number. */
export async function findAllAssignments(
  organizationId: string,
  requestId: string,
): Promise<readonly TechAssignmentRow[]> {
  return db
    .select(assignmentColumns())
    .from(appointmentAssignments)
    .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
    .where(withTenant(appointmentAssignments, organizationId,
      eq(appointments.serviceRequestId, requestId), isNull(appointments.cancelledAt)))
    .orderBy(asc(appointments.appointmentNumber));
}

export async function findActiveVisit(organizationId: string, requestId: string): Promise<ActiveVisit | null> {
  return pickActiveVisit(await findAllAssignments(organizationId, requestId));
}

/** One technician's rows on the request's non-cancelled visits, by visit number. */
export async function findTechAssignments(
  organizationId: string,
  techUserId: string,
  requestId: string,
): Promise<readonly TechAssignmentRow[]> {
  return db
    .select(assignmentColumns())
    .from(appointmentAssignments)
    .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
    .where(withTenant(appointmentAssignments, organizationId,
      eq(appointments.serviceRequestId, requestId), eq(appointmentAssignments.technicianId, techUserId),
      isNull(appointments.cancelledAt)))
    .orderBy(asc(appointments.appointmentNumber));
}

/**
 * Read rule: a row on a non-cancelled visit that is not cancelled or has
 * progress, OR the legacy assigned_to = me. Null when the job is not in the org
 * or not readable by this technician.
 */
export async function findReadableJob(
  organizationId: string,
  techUserId: string,
  requestId: string,
): Promise<{ id: string; customerId: string | null; native: boolean; status: RequestStatus } | null> {
  const [row] = await db
    .select({
      id: serviceRequests.id,
      customerId: serviceRequests.customerId,
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
      hcpJobId: serviceRequests.hcpJobId,
      status: serviceRequests.status,
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId,
      and(eq(serviceRequests.id, requestId), techCanReadSql(organizationId, techUserId))!))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    native: row.fieldpulseJobId === null && row.hcpJobId === null,
    status: row.status,
  };
}

/** EXISTS fragment for set queries over service_requests. Outer parentheses are mandatory (it contains OR). */
export function techCanReadSql(organizationId: string, techUserId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = ${serviceRequests.id} AND a.organization_id = ${organizationId} AND a.technician_id = ${techUserId} AND p.cancelled_at IS NULL AND (a.status <> 'cancelled'::request_status OR a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) OR ${serviceRequests.assignedTo} = ${techUserId})`;
}
