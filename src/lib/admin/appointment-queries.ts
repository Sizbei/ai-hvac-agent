import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import {
  nextAppointmentNumber,
  type AppointmentAssignmentRecord,
  type AppointmentInput,
  type AppointmentPatch,
  type AppointmentRecord,
} from "./appointment-types";

// Visits #2+ (visit #1 is owned by the sync_request_appointment trigger and is
// read-only here: every write is CAS-gated on appointment_number > 1).
// neon-http: each db.batch is ONE implicit transaction; statements outside a
// batch are not, so every multi-statement write below is a single batch.

type Row = typeof appointments.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRecord(row: Row, assignments: readonly AppointmentAssignmentRecord[]): AppointmentRecord {
  return {
    id: row.id, serviceRequestId: row.serviceRequestId, appointmentNumber: row.appointmentNumber,
    scheduledDate: iso(row.scheduledDate), startsAt: iso(row.startsAt), endsAt: iso(row.endsAt),
    arrivalWindowStart: iso(row.arrivalWindowStart), arrivalWindowEnd: iso(row.arrivalWindowEnd),
    isConfirmed: row.isConfirmed, cancelledAt: iso(row.cancelledAt),
    specialInstructions: row.specialInstructions, version: row.version, assignments,
  };
}

async function loadAppointments(organizationId: string, where: SQL): Promise<readonly AppointmentRecord[]> {
  const rows = await db.select().from(appointments)
    .where(withTenant(appointments, organizationId, where))
    .orderBy(asc(appointments.appointmentNumber));
  if (rows.length === 0) return [];
  const assigned = await db
    .select({
      appointmentId: appointmentAssignments.appointmentId, technicianId: appointmentAssignments.technicianId,
      technicianName: users.name, isLead: appointmentAssignments.isLead, status: appointmentAssignments.status,
    })
    .from(appointmentAssignments)
    .innerJoin(users, eq(users.id, appointmentAssignments.technicianId))
    .where(withTenant(appointmentAssignments, organizationId, inArray(appointmentAssignments.appointmentId, rows.map((r) => r.id))))
    .orderBy(desc(appointmentAssignments.isLead), asc(appointmentAssignments.assignedAt), asc(users.name));
  return rows.map((row) => toRecord(row, assigned
    .filter((a) => a.appointmentId === row.id)
    .map(({ technicianId, technicianName, isLead, status }) => ({ technicianId, technicianName, isLead, status }))));
}

/** Request status under the org, or null when it does not exist there. */
async function requestStatus(organizationId: string, requestId: string): Promise<string | null> {
  const [row] = await db.select({ status: serviceRequests.status }).from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId))).limit(1);
  return row?.status ?? null;
}

/** The subset of `ids` that are active technicians in the org (copy of reassignTechnician's check). */
async function activeTechnicianIds(organizationId: string, ids: readonly string[]): Promise<readonly string[]> {
  const rows = await db.select({ id: users.id }).from(users)
    .where(withTenant(users, organizationId, inArray(users.id, [...ids]), eq(users.role, "technician"), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/** "THIS transaction wrote the appointment row" — gates the assignment writes in the same batch. */
function landed(organizationId: string, appointmentId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${appointments} p WHERE p.id = ${appointmentId}::uuid AND p.organization_id = ${organizationId}::uuid AND p.xmin = pg_current_xact_id()::xid)`;
}

/** Insert the assignments (first id = lead) only if this transaction wrote the appointment. */
function insertAssignments(organizationId: string, appointmentId: string, ordered: readonly string[], actorUserId: string) {
  // sql.param(...)::uuid[] renders ONE array parameter; a bare ${ordered} would expand to ($1, $2).
  return db.execute(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_by)
    SELECT ${organizationId}::uuid, ${appointmentId}::uuid, t.id, t.ord = 1, 'assigned'::request_status, ${actorUserId}::uuid
    FROM unnest(${sql.param([...ordered])}::uuid[]) WITH ORDINALITY AS t(id, ord) WHERE ${landed(organizationId, appointmentId)}`);
}

async function getAppointment(organizationId: string, requestId: string, appointmentId: string): Promise<AppointmentRecord | null> {
  const [record] = await loadAppointments(organizationId,
    and(eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId))!);
  return record ?? null;
}

/** All visits on a request (including #1), by number; null when the request is not in the org. */
export async function listAppointments(organizationId: string, requestId: string): Promise<readonly AppointmentRecord[] | null> {
  if ((await requestStatus(organizationId, requestId)) === null) return null;
  return loadAppointments(organizationId, eq(appointments.serviceRequestId, requestId));
}

export type AddAppointmentResult =
  | AppointmentRecord
  | { readonly reason: "request_not_found" | "request_cancelled" | "technician_not_found" | "conflict" };

export async function addAppointment(
  organizationId: string, requestId: string, input: AppointmentInput, actorUserId: string,
): Promise<AddAppointmentResult> {
  const status = await requestStatus(organizationId, requestId);
  if (status === null) return { reason: "request_not_found" };
  // The trigger re-cancels visits while the request is cancelled, so a new one would be lost.
  if (status === "cancelled") return { reason: "request_cancelled" };
  const ordered = [...new Set(input.technicianIds)]; // the caller's order decides the lead
  const found = await activeTechnicianIds(organizationId, ordered);
  if (found.length !== ordered.length) return { reason: "technician_not_found" };
  const start = new Date(input.arrivalWindowStart).toISOString();
  const end = new Date(input.arrivalWindowEnd).toISOString();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await db.select({ appointmentNumber: appointments.appointmentNumber }).from(appointments)
      .where(withTenant(appointments, organizationId, eq(appointments.serviceRequestId, requestId)));
    const appointmentNumber = nextAppointmentNumber(existing);
    const id = randomUUID();
    try {
      // FOR SHARE on the request row: a concurrent cancel either commits first
      // (the re-checked status excludes the row, nothing is inserted) or waits
      // for this batch, after which its trigger cancels the new visit too.
      const [inserted] = await db.batch([
        db.execute(sql`INSERT INTO appointments (id, organization_id, service_request_id, appointment_number,
            starts_at, ends_at, arrival_window_start, arrival_window_end, special_instructions)
          SELECT ${id}::uuid, r.organization_id, r.id, ${appointmentNumber}::smallint,
            ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz, ${input.specialInstructions ?? null}::text
          FROM service_requests r
          WHERE r.id = ${requestId}::uuid AND r.organization_id = ${organizationId}::uuid AND r.status <> 'cancelled'
          FOR SHARE
          RETURNING id`),
        insertAssignments(organizationId, id, ordered, actorUserId),
      ]);
      if (inserted.rows.length === 0) {
        const now = await requestStatus(organizationId, requestId);
        return { reason: now === null ? "request_not_found" : "request_cancelled" };
      }
      const record = await getAppointment(organizationId, requestId, id);
      if (!record) throw new Error("Visit vanished after insert");
      return record;
    } catch (error: unknown) {
      if (isUniqueViolation(error, "appointments_request_number_unique") && attempt === 0) continue;
      if (isUniqueViolation(error)) return { reason: "conflict" };
      throw error;
    }
  }
  return { reason: "conflict" };
}

type MissReason = "not_found" | "is_first_visit" | "request_cancelled" | "version_conflict";

/** Why a CAS matched no row. */
async function classifyMiss(organizationId: string, requestId: string, appointmentId: string, checkCancelled: boolean): Promise<MissReason> {
  const [row] = await db.select({ n: appointments.appointmentNumber }).from(appointments)
    .where(withTenant(appointments, organizationId, eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId))).limit(1);
  if (!row) return "not_found";
  if (row.n === 1) return "is_first_visit";
  if (checkCancelled && (await requestStatus(organizationId, requestId)) === "cancelled") return "request_cancelled";
  return "version_conflict";
}

/** CAS predicate shared by update + cancel: this visit, this request, this version, never #1. */
function casWhere(organizationId: string, requestId: string, appointmentId: string, version: number): SQL {
  return withTenant(appointments, organizationId, eq(appointments.id, appointmentId),
    eq(appointments.serviceRequestId, requestId), eq(appointments.version, version), gt(appointments.appointmentNumber, 1));
}

export type UpdateAppointmentResult =
  | AppointmentRecord
  | { readonly reason: MissReason | "technician_not_found" };

export async function updateAppointment(
  organizationId: string, requestId: string, appointmentId: string, patch: AppointmentPatch, actorUserId: string,
): Promise<UpdateAppointmentResult> {
  const ordered = [...new Set(patch.technicianIds)];
  const found = await activeTechnicianIds(organizationId, ordered);
  if (found.length !== ordered.length) return { reason: "technician_not_found" };
  const start = new Date(patch.arrivalWindowStart);
  const end = new Date(patch.arrivalWindowEnd);
  // ONE batch: CAS update + assignment delete + assignment insert. The latter two
  // are gated on xmin = this transaction (not on version = v + 1): under READ
  // COMMITTED a loser whose CAS matched 0 rows would otherwise see the winner's
  // v + 1 and replace the winner's technicians.
  const [updated] = await db.batch([
    db.update(appointments).set({
      startsAt: start, endsAt: end, arrivalWindowStart: start, arrivalWindowEnd: end,
      specialInstructions: patch.specialInstructions ?? null,
      version: sql`${appointments.version} + 1`, updatedAt: new Date(),
    }).where(and(
      casWhere(organizationId, requestId, appointmentId, patch.version),
      // A cancelled request re-cancels its visits; refuse rather than edit a lost visit.
      sql`EXISTS (SELECT 1 FROM ${serviceRequests} r WHERE r.id = ${appointments.serviceRequestId} AND r.status <> 'cancelled')`,
    )).returning({ id: appointments.id }),
    db.delete(appointmentAssignments).where(withTenant(appointmentAssignments, organizationId,
      eq(appointmentAssignments.appointmentId, appointmentId), landed(organizationId, appointmentId))),
    insertAssignments(organizationId, appointmentId, ordered, actorUserId),
  ]);
  if (updated.length === 0) return { reason: await classifyMiss(organizationId, requestId, appointmentId, true) };
  const record = await getAppointment(organizationId, requestId, appointmentId);
  if (!record) return { reason: "not_found" };
  return record;
}

export type CancelAppointmentResult =
  | { readonly ok: true; readonly appointmentNumber: number }
  | { readonly reason: "not_found" | "version_conflict" | "is_first_visit" };

/** Cancel a visit (#2+): same CAS + the same xmin gate; its assignments go to 'cancelled' in the same batch. */
export async function cancelAppointment(
  organizationId: string, requestId: string, appointmentId: string, version: number,
): Promise<CancelAppointmentResult> {
  const [updated] = await db.batch([
    db.update(appointments).set({
      cancelledAt: sql`COALESCE(${appointments.cancelledAt}, now())`,
      version: sql`${appointments.version} + 1`, updatedAt: new Date(),
    }).where(casWhere(organizationId, requestId, appointmentId, version))
      .returning({ id: appointments.id, appointmentNumber: appointments.appointmentNumber }),
    db.update(appointmentAssignments).set({ status: "cancelled" })
      .where(withTenant(appointmentAssignments, organizationId,
        eq(appointmentAssignments.appointmentId, appointmentId), landed(organizationId, appointmentId))),
  ]);
  const [row] = updated;
  if (!row) {
    const reason = await classifyMiss(organizationId, requestId, appointmentId, false);
    return { reason: reason === "request_cancelled" ? "version_conflict" : reason };
  }
  return { ok: true, appointmentNumber: row.appointmentNumber };
}
