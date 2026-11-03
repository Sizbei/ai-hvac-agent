/**
 * Admin read of a technician's time entries over a business-day range.
 * Job entries carry the request reference and visit number; general entries
 * (no request) come back with both null.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  appointments,
  serviceRequests,
  technicianTimeEntries as tte,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { businessDayBounds } from "@/lib/admin/calendar-time";

export const TIMESHEET_ROW_LIMIT = 500;

export interface TimesheetEntryRow {
  readonly id: string;
  readonly kind: string;
  readonly clockInAt: string;
  readonly clockOutAt: string | null;
  readonly minutes: number | null;
  readonly laborCostCents: number | null;
  readonly referenceNumber: string | null;
  readonly appointmentNumber: number | null;
  readonly clockInMethod: string;
}

/** `from`/`to` are inclusive business-day ISO dates (already validated). */
export async function listTimesheetEntries(
  organizationId: string,
  technicianId: string,
  from: string,
  to: string,
): Promise<readonly TimesheetEntryRow[]> {
  const start = businessDayBounds(from)?.start;
  const end = businessDayBounds(to)?.end;
  if (!start || !end) return [];

  const rows = await db
    .select({
      id: tte.id,
      kind: tte.kind,
      clockInAt: tte.clockInAt,
      clockOutAt: tte.clockOutAt,
      minutes: tte.minutes,
      laborCostCents: tte.laborCostCents,
      referenceNumber: serviceRequests.referenceNumber,
      appointmentNumber: appointments.appointmentNumber,
      clockInMethod: tte.clockInMethod,
    })
    .from(tte)
    .leftJoin(
      serviceRequests,
      and(
        eq(serviceRequests.id, tte.serviceRequestId),
        eq(serviceRequests.organizationId, tte.organizationId),
      ),
    )
    .leftJoin(appointments, eq(appointments.id, tte.appointmentId))
    .where(
      withTenant(
        tte,
        organizationId,
        eq(tte.technicianId, technicianId),
        gte(tte.clockInAt, start),
        lt(tte.clockInAt, end),
      ),
    )
    .orderBy(desc(tte.clockInAt))
    .limit(TIMESHEET_ROW_LIMIT);

  return rows.map((r) => ({
    ...r,
    clockInAt: r.clockInAt.toISOString(),
    clockOutAt: r.clockOutAt ? r.clockOutAt.toISOString() : null,
  }));
}
