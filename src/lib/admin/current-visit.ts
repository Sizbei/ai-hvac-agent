/**
 * Which visit the office shows as current (round-2 P0: hold → resume).
 *
 * The request columns (assigned_to, arrival window) mirror visit #1 only. Once
 * a hold has ended a visit (M3a: hold ENDS the visit; the office plans the next
 * one), or the work moved on to visit #2+, those columns describe a visit the
 * technician's phone no longer shows. The office reads the same visit the phone
 * does instead: the ACTIVE visit of `pickActiveVisit` (src/lib/tech/ownership.ts).
 *
 * Placement kinds:
 *  - "request": the request columns are current (visit #1, or no visit yet).
 *  - "visit":   a later visit (#2+) is the active one; show its window and lead.
 *  - "ended":   a native request on hold whose visits are all over; nothing is
 *               booked until the office schedules the next visit.
 *
 * The SQL here is correlated to "service_requests"."id" (literal, like
 * visit-one-guard.ts) and contains OR, so every fragment is parenthesised.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import type { OfficePlacement } from "./types";

export type { OfficePlacement };

const openList = (): SQL =>
  sql.join(OPEN_ASSIGNMENT_STATUSES.map((s) => sql`${s}::request_status`), sql`, `);

/** Id of the request's active visit, per pickActiveVisit: the earliest live
 * visit with an open row, else the latest live visit with a non-cancelled row. */
export function activeVisitIdSql(): SQL {
  const open = sql`EXISTS (SELECT 1 FROM appointment_assignments oa WHERE oa.appointment_id = av.id AND oa.status IN (${openList()}))`;
  return sql`(SELECT av.id FROM appointments av
    WHERE av.service_request_id = "service_requests"."id" AND av.cancelled_at IS NULL
      AND EXISTS (SELECT 1 FROM appointment_assignments na WHERE na.appointment_id = av.id AND na.status <> 'cancelled'::request_status)
    ORDER BY ${open} DESC, CASE WHEN ${open} THEN av.appointment_number ELSE -av.appointment_number END
    LIMIT 1)`;
}

/** A native request on hold that has visits, none of them still to be worked:
 * no live visit has an open row, and none is a planned visit without anyone on it. */
export function visitEndedSql(): SQL<boolean> {
  return sql<boolean>`("service_requests"."status" = 'on_hold'::request_status
    AND "service_requests"."fieldpulse_job_id" IS NULL AND "service_requests"."hcp_job_id" IS NULL
    AND EXISTS (SELECT 1 FROM appointments ea WHERE ea.service_request_id = "service_requests"."id")
    AND NOT EXISTS (SELECT 1 FROM appointments lw
      WHERE lw.service_request_id = "service_requests"."id" AND lw.cancelled_at IS NULL
        AND (EXISTS (SELECT 1 FROM appointment_assignments la WHERE la.appointment_id = lw.id AND la.status IN (${openList()}))
          OR NOT EXISTS (SELECT 1 FROM appointment_assignments lb WHERE lb.appointment_id = lw.id AND lb.status <> 'cancelled'::request_status))))`;
}

/** The visit the office shows: the latest visit when the work has ended, else the active one. */
export function displayVisitIdSql(): SQL {
  return sql`(CASE WHEN ${visitEndedSql()}
    THEN (SELECT lv.id FROM appointments lv WHERE lv.service_request_id = "service_requests"."id" ORDER BY lv.appointment_number DESC LIMIT 1)
    ELSE ${activeVisitIdSql()} END)`;
}

/** JSON text of the displayed visit (window, lead, ended), or NULL when the
 * request columns are current anyway. Parse with parseOfficeVisit. The CASE is a
 * cheap gate: only a request on hold or with a visit #2+ can be placed by a
 * visit, so every other row skips the subqueries. */
export function officeVisitSql(): SQL<string | null> {
  return sql<string | null>`(CASE WHEN "service_requests"."status" = 'on_hold'::request_status
      OR EXISTS (SELECT 1 FROM appointments g WHERE g.service_request_id = "service_requests"."id" AND g.appointment_number > 1)
    THEN (SELECT json_build_object(
      'id', ov.id, 'number', ov.appointment_number,
      'start', ov.arrival_window_start, 'end', ov.arrival_window_end,
      'ended', ${visitEndedSql()},
      'leadId', ol.technician_id, 'leadStatus', ol.status,
      'leadName', CASE WHEN ou.is_active THEN ou.name END)::text
    FROM appointments ov
    LEFT JOIN LATERAL (SELECT a.technician_id, a.status FROM appointment_assignments a
      WHERE a.appointment_id = ov.id AND a.is_lead
      ORDER BY (a.status <> 'cancelled'::request_status) DESC LIMIT 1) ol ON true
    LEFT JOIN users ou ON ou.id = ol.technician_id
    WHERE ov.id = ${displayVisitIdSql()}) END)`;
}

/** For the office's placement queries: the displayed visit is not what the request columns say. */
export function placedByVisitSql(): SQL<boolean> {
  return sql<boolean>`(${visitEndedSql()} OR COALESCE((SELECT p.appointment_number FROM appointments p WHERE p.id = ${activeVisitIdSql()}), 1) > 1)`;
}

export interface OfficeVisit {
  readonly id: string;
  readonly number: number;
  readonly start: string | null;
  readonly end: string | null;
  readonly ended: boolean;
  readonly leadId: string | null;
  readonly leadStatus: string | null;
  readonly leadName: string | null;
}


const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** officeVisitSql's JSON text (or an already-parsed object) → OfficeVisit; null for anything else. */
export function parseOfficeVisit(raw: unknown): OfficeVisit | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.number !== "number") return null;
  return {
    id: v.id,
    number: v.number,
    start: isoOrNull(v.start),
    end: isoOrNull(v.end),
    ended: v.ended === true,
    leadId: strOrNull(v.leadId),
    leadStatus: strOrNull(v.leadStatus),
    leadName: strOrNull(v.leadName),
  };
}

/** Which source the office shows for a request. */
export function officePlacement(visit: OfficeVisit | null): OfficePlacement {
  if (!visit) return { kind: "request" };
  if (!visit.ended && visit.number <= 1) return { kind: "request" };
  // An ended visit keeps the technician it was booked with (their row is now
  // cancelled or done); a live visit's lead is only a lead while not cancelled.
  const lead = visit.ended || visit.leadStatus !== "cancelled";
  return {
    kind: visit.ended ? "ended" : "visit",
    appointmentId: visit.id,
    appointmentNumber: visit.number,
    arrivalWindowStart: visit.start,
    arrivalWindowEnd: visit.end,
    technicianId: lead ? visit.leadId : null,
    technicianName: lead ? visit.leadName : null,
  };
}

interface PlaceableJob {
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly assignedToName: string | null;
}

/** A calendar/dispatch card as the office should see it, and the technician
 * lane it belongs in (null = the unassigned pile). */
export function placeOfficeJob<J extends PlaceableJob>(
  job: J,
  assignedTo: string | null,
  placement: OfficePlacement,
): { readonly job: J & { readonly visitNumber?: number; readonly visitEnded?: boolean }; readonly technicianId: string | null } {
  if (placement.kind === "request") return { job, technicianId: assignedTo };
  const ended = placement.kind === "ended";
  return {
    job: {
      ...job,
      arrivalWindowStart: placement.arrivalWindowStart,
      arrivalWindowEnd: placement.arrivalWindowEnd,
      assignedToName: placement.technicianName ?? (ended ? job.assignedToName : null),
      visitNumber: placement.appointmentNumber,
      ...(ended ? { visitEnded: true } : {}),
    },
    technicianId: placement.technicianId ?? (ended ? assignedTo : null),
  };
}

/** True when the request is a native hold whose visits are all over (the
 * office must schedule the next visit; a bare status resume would reuse none). */
export async function readVisitEnded(organizationId: string, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ ended: visitEndedSql() })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  return row?.ended === true;
}
