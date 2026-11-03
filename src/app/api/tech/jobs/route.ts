/**
 * Stage 7 — technician field view: "my jobs".
 *
 * Lists the calling technician's visits (assignment rows) by range: today / upcoming / past, with the
 * address decrypted (the tech needs it to drive there). Reuses the JWT admin
 * session (technician role). Tenant-scoped to the tech's org.
 */
import { asc, eq, isNull, or, sql } from "drizzle-orm";
import { getTechSession } from "@/lib/auth/tech-session";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { businessTodayIso } from "@/lib/admin/availability-queries";
import { classifyVisit, VISIT_RANGES, PAST_WINDOW_DAYS, type VisitRange } from "@/lib/tech/visit-range";

export const dynamic = "force-dynamic";

function safeDecrypt(v: string | null): string | null {
  if (!v) return null;
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

const windowStart = sql<Date | null>`COALESCE(${appointments.startsAt}, ${serviceRequests.arrivalWindowStart})`.mapWith(serviceRequests.arrivalWindowStart);
const windowEnd = sql<Date | null>`COALESCE(${appointments.endsAt}, ${serviceRequests.arrivalWindowEnd})`.mapWith(serviceRequests.arrivalWindowEnd);
const visitDate = sql<Date | null>`COALESCE(${appointments.scheduledDate}, ${serviceRequests.scheduledDate})`.mapWith(serviceRequests.scheduledDate);

export async function GET(request: Request) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rangeParam = new URL(request.url).searchParams.get("range") ?? "today";
    if (!(VISIT_RANGES as readonly string[]).includes(rangeParam)) {
      return errorResponse("Invalid range", "VALIDATION_ERROR", 400);
    }
    const range = rangeParam as VisitRange;

    const rows = await db
      .select({
        id: serviceRequests.id,
        referenceNumber: serviceRequests.referenceNumber,
        status: serviceRequests.status,
        issueType: serviceRequests.issueType,
        urgency: serviceRequests.urgency,
        description: serviceRequests.description,
        scheduledDate: visitDate,
        arrivalWindowStart: windowStart,
        arrivalWindowEnd: windowEnd,
        addressEncrypted: serviceRequests.addressEncrypted,
        customerNameEncrypted: serviceRequests.customerNameEncrypted,
        accessNotes: serviceRequests.accessNotes,
        appointmentId: appointments.id,
        appointmentNumber: appointments.appointmentNumber,
        assignmentStatus: appointmentAssignments.status,
        isLead: appointmentAssignments.isLead,
        completedAt: appointmentAssignments.completedAt,
      })
      .from(appointmentAssignments)
      .innerJoin(appointments, eq(appointments.id, appointmentAssignments.appointmentId))
      .innerJoin(serviceRequests, eq(serviceRequests.id, appointments.serviceRequestId))
      .where(
        withTenant(
          appointmentAssignments,
          session.organizationId,
          eq(appointmentAssignments.technicianId, session.userId),
          isNull(appointments.cancelledAt),
          // A cancelled row without progress 404s on tap, so it is not listed.
          or(
            sql`${appointmentAssignments.status} <> 'cancelled'::request_status`,
            sql`${appointmentAssignments.enRouteAt} IS NOT NULL`,
            sql`${appointmentAssignments.arrivedAt} IS NOT NULL`,
            sql`${appointmentAssignments.startedAt} IS NOT NULL`,
            sql`${appointmentAssignments.completedAt} IS NOT NULL`,
          )!,
          // Bound old terminal rows in SQL (30 days + a day of timezone slack); classifyVisit makes the exact cut.
          or(
            sql`${appointmentAssignments.status} NOT IN ('completed'::request_status, 'cancelled'::request_status)`,
            sql`COALESCE(${appointmentAssignments.completedAt}, ${visitDate}) IS NULL`,
            sql`COALESCE(${appointmentAssignments.completedAt}, ${visitDate}) >= now() - interval '${sql.raw(String(PAST_WINDOW_DAYS + 1))} days'`,
          )!,
        ),
      )
      .orderBy(asc(windowStart), asc(appointments.appointmentNumber));

    const todayIso = businessTodayIso(new Date());
    const day = (d: Date | null): string | null => (d ? businessTodayIso(d) : null);

    const jobs = rows
      .filter(
        (r) =>
          classifyVisit(
            {
              assignmentStatus: r.assignmentStatus,
              requestStatus: r.status,
              scheduledDay: day(r.scheduledDate),
              completedDay: day(r.completedAt),
            },
            todayIso,
          ) === range,
      )
      .map((r) => ({
        id: r.id,
        referenceNumber: r.referenceNumber,
        status: r.status,
        issueType: r.issueType,
        urgency: r.urgency,
        description: r.description,
        scheduledDate: r.scheduledDate?.toISOString() ?? null,
        arrivalWindowStart: r.arrivalWindowStart?.toISOString() ?? null,
        arrivalWindowEnd: r.arrivalWindowEnd?.toISOString() ?? null,
        address: safeDecrypt(r.addressEncrypted),
        customerName: safeDecrypt(r.customerNameEncrypted),
        accessNotes: r.accessNotes,
        appointmentId: r.appointmentId,
        appointmentNumber: r.appointmentNumber,
        assignmentStatus: r.assignmentStatus,
        isLead: r.isLead,
      }));
    if (range === "past") jobs.reverse();

    return successResponse({ jobs });
  } catch (error) {
    logger.error({ error }, "Failed to load technician jobs");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
