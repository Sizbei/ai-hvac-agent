/**
 * Pure SQL builders for automatic job time entries. Status taps and visit
 * helpers run these inside a db.batch so the entry lands (or closes) in the
 * same transaction as the assignment write that caused it.
 *
 * Labor math is the one shared formula (trigger, these builders, clockOut):
 * minutes = GREATEST(0, FLOOR(elapsed seconds / 60)),
 * labor cost = ROUND(minutes / 60.0 * rate).
 */
import { sql, type SQL } from "drizzle-orm";

/** Open an auto job entry for (request, tech) unless one is already open; gated on the caller's assignment row having been written in this transaction. */
export function openJobEntrySql(p: {
  organizationId: string;
  requestId: string;
  techUserId: string;
  appointmentId: string;
  gateAssignmentId: string;
}): SQL {
  return sql`INSERT INTO technician_time_entries (organization_id, service_request_id, technician_id, appointment_id, kind, clock_in_method, clock_in_at)
    SELECT ${p.organizationId}::uuid, ${p.requestId}::uuid, ${p.techUserId}::uuid, ${p.appointmentId}::uuid, 'job', 'auto', now()
    WHERE EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = ${p.gateAssignmentId}::uuid AND a.xmin = pg_current_xact_id()::xid)
    ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING`;
}

const MINUTES = sql`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60))`;

/** Close the open job entries on the request for the given technicians (all technicians when omitted); `gate` is any boolean SQL the caller supplies. */
export function closeJobEntriesSql(p: {
  organizationId: string;
  requestId: string;
  technicianIds?: readonly string[];
  gate?: SQL;
}): SQL {
  // sql.param(...)::uuid[] renders ONE array parameter; a bare array would expand to ($1, $2).
  const techFilter = p.technicianIds
    ? sql` AND t.technician_id = ANY(${sql.param([...p.technicianIds])}::uuid[])`
    : sql``;
  const gate = p.gate ? sql` AND (${p.gate})` : sql``;
  return sql`UPDATE technician_time_entries t SET clock_out_at = now(),
      minutes = ${MINUTES}::int,
      labor_rate_cents = COALESCE(u.labor_rate_cents, 0),
      labor_cost_cents = ROUND(${MINUTES} / 60.0 * COALESCE(u.labor_rate_cents, 0))::int,
      updated_at = now()
    FROM users u
    WHERE u.id = t.technician_id AND t.organization_id = ${p.organizationId}::uuid AND t.service_request_id = ${p.requestId}::uuid${techFilter}
      AND t.kind = 'job' AND t.clock_out_at IS NULL${gate}`;
}
