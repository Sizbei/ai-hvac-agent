/**
 * Technician status writes (and the two admin paths that follow the same
 * rules). Each writer is ONE db.batch (neon-http: one implicit transaction)
 * that starts by locking the request row, so taps, holds and close-outs on the
 * same request serialise; holdVisit then locks the visit row before touching
 * its assignment rows (request -> visit -> rows, the admin paths' order).
 * Gated statements use "THIS transaction wrote the row" (xmin) or an explicit
 * post-condition, never a re-read between statements.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canTransition, type HoldReason, type RequestStatus } from "@/lib/admin/request-status";
import { recordStatusEvent } from "@/lib/admin/status-events";
import { hasProgress, isOpen, OPEN_ASSIGNMENT_STATUSES, type TechAssignmentRow } from "./ownership";
import { closeOutAllowedStatuses, type Blocker, type Resolved } from "./status-actions";
import { closeJobEntriesSql, openJobEntrySql } from "./time-entry-sql";

type Stamp = "enRouteAt" | "arrivedAt" | "startedAt" | "completedAt";
type BatchResult = { rows: Record<string, unknown>[] };

const STAMP_COLUMN: Record<Stamp, string> = {
  enRouteAt: "en_route_at", arrivedAt: "arrived_at", startedAt: "started_at", completedAt: "completed_at",
};
const OPEN_IN = sql.raw(`(${OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(", ")})`);
const HOLDABLE_IN = sql.raw("('scheduled', 'assigned', 'en_route', 'arrived', 'in_progress')");
const NATIVE = sql.raw("fieldpulse_job_id IS NULL AND hcp_job_id IS NULL");
const S_NATIVE = sql.raw("s.fieldpulse_job_id IS NULL AND s.hcp_job_id IS NULL");
const ROW_PROGRESS = sql.raw("(en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL OR completed_at IS NOT NULL)");
const A_PROGRESS = sql.raw("(a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)");

/** Lock order: every batch here starts with this. */
const lockRequest = (org: string, rid: string) =>
  db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`);

const rowLanded = (aid: string): SQL =>
  sql`EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = ${aid}::uuid AND a.xmin = pg_current_xact_id()::xid)`;

const requestLanded = (rid: string): SQL =>
  sql`EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.xmin = pg_current_xact_id()::xid)`;

const noOpenRowOnVisit = (appt: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = ${appt}::uuid AND a.status IN ${OPEN_IN})`;

/** SQLSTATE 40P01 anywhere in the cause chain (Drizzle wraps the driver error). */
export function isDeadlock(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e != null && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === "40P01") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function runBatch(items: readonly unknown[]): Promise<BatchResult[]> {
  return (await db.batch(items as never)) as unknown as BatchResult[];
}

/** The request's status and whether it is native, or null outside the org. */
export async function readRequestState(org: string, rid: string): Promise<{ status: RequestStatus; native: boolean } | null> {
  const [row] = await db
    .select({ status: serviceRequests.status, native: sql<boolean>`(${serviceRequests.fieldpulseJobId} IS NULL AND ${serviceRequests.hcpJobId} IS NULL)` })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, org, eq(serviceRequests.id, rid)));
  return row ?? null;
}

async function readRow(org: string, aid: string) {
  const [row] = await db
    .select({
      status: appointmentAssignments.status, enRouteAt: appointmentAssignments.enRouteAt,
      arrivedAt: appointmentAssignments.arrivedAt, startedAt: appointmentAssignments.startedAt,
      completedAt: appointmentAssignments.completedAt,
    })
    .from(appointmentAssignments)
    .where(withTenant(appointmentAssignments, org, eq(appointmentAssignments.id, aid)));
  return row ?? null;
}

const event = (org: string, rid: string, from: RequestStatus, to: RequestStatus, actorId: string) =>
  recordStatusEvent({ organizationId: org, serviceRequestId: rid, fromStatus: from, toStatus: to, actorType: "human", actorId });

type Applied = { ok: true; assignmentStatus: RequestStatus; requestStatus: RequestStatus; requestBehind: boolean } | { ok: false; reason: "stale" };

export async function applyTechAction(p: {
  organizationId: string; techUserId: string; requestId: string; row: TechAssignmentRow;
  resolved: Extract<Resolved, { kind: "write" | "request_only" }>; requestStatus: RequestStatus; activeVisitId: string | null;
}): Promise<Applied> {
  const { organizationId: org, requestId: rid, row, resolved } = p;
  const aid = row.assignmentId;
  const laterVisitLead = row.isLead && row.appointmentId !== p.activeVisitId;
  const requestTo = resolved.requestTo;
  const requestUpdate = (gate: SQL) => db.execute(sql`UPDATE service_requests SET status = ${requestTo}::request_status, completed_at = NULL, hold_reason = NULL, follow_up_date = NULL, updated_at = now() WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid AND status = ${p.requestStatus}::request_status AND ${NATIVE} AND ${gate} RETURNING status`);

  try {
    if (resolved.kind === "request_only") {
      const [, req] = await runBatch([
        lockRequest(org, rid),
        requestUpdate(sql`EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = ${aid}::uuid AND a.status = ${resolved.requestTo}::request_status)`),
      ]);
      const moved = req!.rows.length > 0;
      if (moved) await event(org, rid, p.requestStatus, resolved.requestTo, p.techUserId);
      return { ok: true, assignmentStatus: resolved.requestTo, requestStatus: moved ? resolved.requestTo : p.requestStatus, requestBehind: !moved || laterVisitLead };
    }

    const to = resolved.assignmentTo;
    const stampSet = resolved.stamp ? sql`, ${sql.raw(STAMP_COLUMN[resolved.stamp])} = COALESCE(${sql.raw(STAMP_COLUMN[resolved.stamp])}, now())` : sql``;
    const items: unknown[] = [
      lockRequest(org, rid),
      db.execute(sql`UPDATE appointment_assignments SET status = ${to}::request_status${stampSet} WHERE id = ${aid}::uuid AND organization_id = ${org}::uuid AND status = ${row.status}::request_status RETURNING id`),
    ];
    if (requestTo) items.push(requestUpdate(rowLanded(aid)));
    if (resolved.timeEntry === "open") {
      items.push(db.execute(openJobEntrySql({ organizationId: org, requestId: rid, techUserId: p.techUserId, appointmentId: row.appointmentId, gateAssignmentId: aid })));
    } else if (resolved.timeEntry === "close") {
      items.push(db.execute(closeJobEntriesSql({ organizationId: org, requestId: rid, technicianIds: [p.techUserId], gate: rowLanded(aid) })));
    }
    const results = await runBatch(items);

    if (results[1]!.rows.length === 0) {
      const now = await readRow(org, aid);
      const atTarget = now !== null && now.status === to && (resolved.stamp === null || now[resolved.stamp] !== null);
      if (!atTarget) return { ok: false, reason: "stale" };
      // A concurrent tap may have moved the request too: report it as it is now.
      const request = requestTo ? await readRequestState(org, rid) : null;
      const requestStatus = request?.status ?? p.requestStatus;
      return { ok: true, assignmentStatus: to, requestStatus, requestBehind: (requestTo !== null && requestStatus !== requestTo) || laterVisitLead };
    }
    const moved = requestTo !== null && results[2]!.rows.length > 0;
    if (moved) await event(org, rid, p.requestStatus, requestTo, p.techUserId);
    return {
      ok: true, assignmentStatus: to, requestStatus: moved ? requestTo : p.requestStatus,
      requestBehind: (Boolean(requestTo) && !moved) || laterVisitLead,
    };
  } catch (error) {
    if (isDeadlock(error)) return { ok: false, reason: "stale" };
    throw error;
  }
}

export async function holdVisit(p: {
  organizationId: string; actorUserId: string; requestId: string; appointmentId: string | null;
  holdReason: HoldReason | null; followUpDate: Date | null; requestStatus: RequestStatus;
}): Promise<{ ok: true } | { ok: false; reason: "stale" | "invalid_transition" }> {
  if (!canTransition(p.requestStatus, "on_hold")) return { ok: false, reason: "invalid_transition" };
  const { organizationId: org, requestId: rid, appointmentId: appt } = p;
  const rowGate = appt ? sql` AND ${noOpenRowOnVisit(appt)}` : sql``;
  const holdRequest = db.execute(sql`WITH prev AS (SELECT status FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid) UPDATE service_requests s SET status = 'on_hold'::request_status, hold_reason = ${p.holdReason}::hold_reason, follow_up_date = ${p.followUpDate?.toISOString() ?? null}::timestamptz, updated_at = now() FROM prev WHERE s.id = ${rid}::uuid AND s.organization_id = ${org}::uuid AND s.status IN ${HOLDABLE_IN} AND ${S_NATIVE}${rowGate} RETURNING prev.status AS from_status`);

  const items: unknown[] = [lockRequest(org, rid)];
  if (appt) {
    items.push(
      db.execute(sql`SELECT 1 FROM appointments WHERE id = ${appt}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`),
      db.execute(sql`UPDATE appointment_assignments SET status = CASE WHEN ${ROW_PROGRESS} THEN 'completed'::request_status ELSE 'cancelled'::request_status END, completed_at = CASE WHEN ${ROW_PROGRESS} THEN COALESCE(completed_at, now()) ELSE completed_at END WHERE appointment_id = ${appt}::uuid AND organization_id = ${org}::uuid AND status IN ${OPEN_IN} AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.status IN ${HOLDABLE_IN} AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL) RETURNING id, technician_id`),
      holdRequest,
      db.execute(closeJobEntriesSql({
        organizationId: org, requestId: rid,
        // every technician on the visit, read inside the transaction
        gate: sql`t.technician_id IN (SELECT a.technician_id FROM appointment_assignments a WHERE a.appointment_id = ${appt}::uuid) AND ${noOpenRowOnVisit(appt)}`,
      })),
      db.execute(sql`UPDATE appointments SET cancelled_at = now(), version = version + 1, updated_at = now() WHERE id = ${appt}::uuid AND organization_id = ${org}::uuid AND cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = ${appt}::uuid AND a.status <> 'cancelled')`),
    );
  } else {
    items.push(holdRequest);
  }

  try {
    const results = await runBatch(items);
    const held = results[appt ? 3 : 1]!.rows[0] as { from_status: RequestStatus } | undefined;
    if (held) {
      await event(org, rid, held.from_status, "on_hold", p.actorUserId);
      return { ok: true };
    }
    const now = await readRequestState(org, rid);
    return now?.status === "on_hold" ? { ok: true } : { ok: false, reason: "stale" };
  } catch (error) {
    if (isDeadlock(error)) return { ok: false, reason: "stale" };
    throw error;
  }
}

const completeRequest = (org: string, rid: string, guard: SQL) =>
  db.execute(sql`WITH prev AS (SELECT status FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE) UPDATE service_requests s SET status = 'completed'::request_status, completed_at = now(), hold_reason = NULL, follow_up_date = NULL, updated_at = now() FROM prev WHERE s.id = ${rid}::uuid AND s.organization_id = ${org}::uuid AND s.status IN ('in_progress', 'on_hold') AND ${S_NATIVE} AND ${guard} RETURNING prev.status AS from_status`);

const openRowsOnLiveVisits = (rid: string, extra: SQL = sql``) =>
  sql`NOT EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = ${rid}::uuid AND p.cancelled_at IS NULL AND a.status IN ${OPEN_IN}${extra})`;

export async function closeOutRequest(p: {
  organizationId: string; techUserId: string; requestId: string; row: TechAssignmentRow;
}): Promise<{ ok: true; changed: boolean } | { ok: false; assignmentStatus: RequestStatus; blockers: Blocker[] }> {
  const { organizationId: org, requestId: rid } = p;
  const aid = p.row.assignmentId;
  const results = await runBatch([
    lockRequest(org, rid),
    db.execute(sql`UPDATE appointment_assignments SET status = 'completed'::request_status, completed_at = COALESCE(completed_at, now()) WHERE id = ${aid}::uuid AND organization_id = ${org}::uuid AND status IN ${OPEN_IN} AND started_at IS NOT NULL AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.status IN ('in_progress', 'on_hold')) RETURNING id`),
    completeRequest(org, rid, openRowsOnLiveVisits(rid)),
    db.execute(closeJobEntriesSql({
      organizationId: org, requestId: rid, technicianIds: [p.techUserId],
      gate: sql`EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = ${aid}::uuid AND a.status = 'completed')`,
    })),
  ]);
  const done = results[2]!.rows[0] as { from_status: RequestStatus } | undefined;
  if (done) {
    await event(org, rid, done.from_status, "completed", p.techUserId);
    return { ok: true, changed: true };
  }
  const now = await readRequestState(org, rid);
  if (now?.status === "completed") return { ok: true, changed: false };
  const mine = await readRow(org, aid);
  return {
    ok: false,
    assignmentStatus: mine?.status ?? p.row.status,
    blockers: await closeOutBlockers(org, rid, { technicianId: p.techUserId, appointmentId: p.row.appointmentId }),
  };
}

export async function completeRequestFromAdmin(p: {
  organizationId: string; actorUserId: string; requestId: string;
}): Promise<
  | { ok: true; changed: boolean }
  | { ok: false; reason: "blocked"; blockers: Blocker[] }
  | { ok: false; reason: "invalid_transition"; currentStatus: RequestStatus }
> {
  const { organizationId: org, requestId: rid } = p;
  const results = await runBatch([
    lockRequest(org, rid),
    completeRequest(org, rid, openRowsOnLiveVisits(rid, sql` AND ${A_PROGRESS}`)),
    // untouched rows are cancelled so no open row survives on a completed request
    db.execute(sql`UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p WHERE p.id = a.appointment_id AND p.service_request_id = ${rid}::uuid AND a.organization_id = ${org}::uuid AND a.status IN ${OPEN_IN} AND ${requestLanded(rid)}`),
    db.execute(closeJobEntriesSql({ organizationId: org, requestId: rid, gate: requestLanded(rid) })),
  ]);
  const done = results[1]!.rows[0] as { from_status: RequestStatus } | undefined;
  if (done) {
    await event(org, rid, done.from_status, "completed", p.actorUserId);
    return { ok: true, changed: true };
  }
  const now = await readRequestState(org, rid);
  const status = now?.status ?? "pending";
  if (status !== "in_progress" && status !== "on_hold") return { ok: false, reason: "invalid_transition", currentStatus: status };
  const blockers: Blocker[] = (await loadVisitRows(org, rid))
    .filter((r) => isOpen(r.status) && hasProgress(r))
    .map((r) => ({ kind: "technician_open", technicianName: r.technicianName, technicianId: r.technicianId, appointmentNumber: r.appointmentNumber }));
  return { ok: false, reason: "blocked", blockers };
}

/** Every row on the request's non-cancelled visits, with names (names go to response bodies only). */
async function loadVisitRows(org: string, rid: string) {
  const rows = await db
    .select({
      assignmentId: appointmentAssignments.id, appointmentId: appointmentAssignments.appointmentId,
      appointmentNumber: appointments.appointmentNumber, technicianId: appointmentAssignments.technicianId,
      technicianName: users.name, status: appointmentAssignments.status,
      enRouteAt: appointmentAssignments.enRouteAt, arrivedAt: appointmentAssignments.arrivedAt,
      startedAt: appointmentAssignments.startedAt, completedAt: appointmentAssignments.completedAt,
      windowStart: appointments.arrivalWindowStart, scheduledDate: appointments.scheduledDate,
    })
    .from(appointmentAssignments)
    .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
    .innerJoin(users, eq(users.id, appointmentAssignments.technicianId))
    .where(withTenant(appointmentAssignments, org,
      eq(appointments.serviceRequestId, rid), sql`${appointments.cancelledAt} IS NULL`))
    .orderBy(appointments.appointmentNumber);
  return rows;
}

const CLOSE_OUT_STATUSES = closeOutAllowedStatuses();

/** Why the request cannot be closed out now (empty when it can). */
export async function closeOutBlockers(
  organizationId: string,
  requestId: string,
  caller?: { technicianId: string; appointmentId: string },
): Promise<Blocker[]> {
  const [req] = await db.select({ status: serviceRequests.status }).from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  const rows = await loadVisitRows(organizationId, requestId);
  const isMine = (r: { technicianId: string; appointmentId: string }) =>
    caller !== undefined && r.technicianId === caller.technicianId && r.appointmentId === caller.appointmentId;
  const callerNumber = rows.find(isMine)?.appointmentNumber;
  const open = rows.filter((r) => isOpen(r.status));
  const ref = callerNumber ?? Math.min(...open.map((r) => r.appointmentNumber));
  const status = req?.status ?? "pending";

  const out: Blocker[] = [];
  // My own open row blocks only while it has not started (close-out completes a started one).
  if (!CLOSE_OUT_STATUSES.includes(status) || open.some((r) => isMine(r) && r.startedAt === null)) {
    out.push({ kind: "request_not_started", status });
  }
  const planned = new Set<number>();
  for (const r of open) {
    if (isMine(r)) continue;
    if (callerNumber !== undefined && r.appointmentNumber < callerNumber) {
      out.push({ kind: "earlier_visit_open", technicianName: r.technicianName, appointmentNumber: r.appointmentNumber });
    } else if (r.appointmentNumber > ref && !hasProgress(r)) {
      if (planned.has(r.appointmentNumber)) continue;
      planned.add(r.appointmentNumber);
      out.push({ kind: "visit_planned", appointmentNumber: r.appointmentNumber, date: (r.windowStart ?? r.scheduledDate)?.toISOString() ?? null });
    } else {
      out.push({ kind: "technician_open", technicianName: r.technicianName, technicianId: r.technicianId, appointmentNumber: r.appointmentNumber });
    }
  }
  return out;
}
