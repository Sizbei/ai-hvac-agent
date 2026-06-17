/**
 * Technician labor tracking → job-cost — server-side queries.
 *
 * A technician clocks IN and OUT per job. The actual labor cost (minutes × the
 * tech's snapshotted hourly rate) rolls into the admin invoice's actual-vs-
 * estimated margin (margin = revenue − actual materials − actual labor).
 *
 * Every clock mutation is scoped to BOTH the assigned tech (assignedTo ==
 * techUserId) AND the org (withTenant) — a tech may only clock their OWN job.
 * The assignee+tenant guard mirrors src/lib/tech/field-queries.ts exactly.
 *
 * Money is integer cents; minutes are integers. The labor RATE is snapshotted
 * from the user's labor_rate_cents AT CLOCK-OUT (fallback 0) so a later rate
 * change never rewrites historical job-cost. neon-http has no transactions, so
 * the clock-out (which reads the open entry + the rate, then writes) uses a
 * single guarded UPDATE.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, technicianTimeEntries, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { rollUpActualLaborCost } from "@/lib/admin/margin";

/**
 * Assignee + tenant guard: returns the job id only if it exists in this org AND
 * is assigned to this tech. Mirrors findOwnedJob in field-queries / the status
 * route (org-scoped + assignee-scoped).
 */
async function findOwnedJob(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<string | null> {
  const [owned] = await db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, serviceRequestId),
          eq(serviceRequests.assignedTo, techUserId),
        )!,
      ),
    )
    .limit(1);
  return owned?.id ?? null;
}

export interface TimeEntryRow {
  readonly id: string;
  readonly technicianId: string;
  readonly clockInAt: Date;
  readonly clockOutAt: Date | null;
  readonly minutes: number | null;
  readonly laborRateCents: number;
  readonly laborCostCents: number | null;
  readonly note: string | null;
}

export type ClockInResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_owned" | "already_open" };

/**
 * Start the clock on a job for this tech. Rejects if the tech already has an
 * OPEN entry on this job (the partial unique index `tte_open_per_tech_job_unique`
 * is the authoritative guard behind this read-then-insert pre-check, which races
 * under concurrency). Assignee + tenant guarded.
 */
export async function clockIn(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<ClockInResult> {
  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  const [open] = await db
    .select({ id: technicianTimeEntries.id })
    .from(technicianTimeEntries)
    .where(
      withTenant(
        technicianTimeEntries,
        organizationId,
        eq(technicianTimeEntries.serviceRequestId, serviceRequestId),
        eq(technicianTimeEntries.technicianId, techUserId),
        isNull(technicianTimeEntries.clockOutAt),
      ),
    )
    .limit(1);
  if (open) {
    return { ok: false, reason: "already_open" };
  }

  const [created] = await db
    .insert(technicianTimeEntries)
    .values({
      organizationId,
      serviceRequestId,
      technicianId: techUserId,
      clockInAt: new Date(),
    })
    .returning({ id: technicianTimeEntries.id });

  if (!created) {
    throw new Error("Failed to clock in");
  }
  return { ok: true, id: created.id };
}

export type ClockOutResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly minutes: number;
      readonly laborCostCents: number;
    }
  | { readonly ok: false; readonly reason: "not_owned" | "no_open_entry" };

/** Whole minutes elapsed between two instants (never negative). */
function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}

/** round(minutes / 60 × rate cents/hour) in integer cents. */
function computeLaborCostCents(minutes: number, laborRateCents: number): number {
  return Math.round((minutes / 60) * laborRateCents);
}

/**
 * Stop the clock on this tech's OPEN entry for a job. Computes minutes from the
 * stored clock-in, SNAPSHOTS the tech's current labor rate (fallback 0), derives
 * laborCostCents = round(minutes/60 × rate), and closes the entry. Assignee +
 * tenant guarded. The rate read + the close write run as one db.batch.
 */
export async function clockOut(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<ClockOutResult> {
  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  // The open entry for THIS tech on THIS job (org-scoped + assignee-scoped via
  // technicianId). At most one exists (partial unique index).
  const [open] = await db
    .select({
      id: technicianTimeEntries.id,
      clockInAt: technicianTimeEntries.clockInAt,
    })
    .from(technicianTimeEntries)
    .where(
      withTenant(
        technicianTimeEntries,
        organizationId,
        eq(technicianTimeEntries.serviceRequestId, serviceRequestId),
        eq(technicianTimeEntries.technicianId, techUserId),
        isNull(technicianTimeEntries.clockOutAt),
      ),
    )
    .limit(1);
  if (!open) {
    return { ok: false, reason: "no_open_entry" };
  }

  // Snapshot the tech's hourly rate (tenant-scoped). NULL → 0: a tech with no
  // rate set accrues 0 labor cost rather than blocking clock-out.
  const [tech] = await db
    .select({ laborRateCents: users.laborRateCents })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, techUserId)))
    .limit(1);
  const laborRateCents = tech?.laborRateCents ?? 0;

  const clockOutAt = new Date();
  const minutes = minutesBetween(open.clockInAt, clockOutAt);
  const laborCostCents = computeLaborCostCents(minutes, laborRateCents);

  // Close the entry. Re-assert the open-entry filter (clock_out_at IS NULL) in
  // the WHERE so a concurrent clock-out can't double-close it. Tenant-scoped.
  await db.batch([
    db
      .update(technicianTimeEntries)
      .set({
        clockOutAt,
        minutes,
        laborRateCents,
        laborCostCents,
        updatedAt: new Date(),
      })
      .where(
        withTenant(
          technicianTimeEntries,
          organizationId,
          eq(technicianTimeEntries.id, open.id),
          isNull(technicianTimeEntries.clockOutAt),
        ),
      ),
  ]);

  return { ok: true, id: open.id, minutes, laborCostCents };
}

/** List the time entries on a job (org-scoped read), oldest first. */
export async function listTimeEntries(
  organizationId: string,
  serviceRequestId: string,
): Promise<readonly TimeEntryRow[]> {
  return db
    .select({
      id: technicianTimeEntries.id,
      technicianId: technicianTimeEntries.technicianId,
      clockInAt: technicianTimeEntries.clockInAt,
      clockOutAt: technicianTimeEntries.clockOutAt,
      minutes: technicianTimeEntries.minutes,
      laborRateCents: technicianTimeEntries.laborRateCents,
      laborCostCents: technicianTimeEntries.laborCostCents,
      note: technicianTimeEntries.note,
    })
    .from(technicianTimeEntries)
    .where(
      withTenant(
        technicianTimeEntries,
        organizationId,
        eq(technicianTimeEntries.serviceRequestId, serviceRequestId),
      ),
    )
    .orderBy(asc(technicianTimeEntries.clockInAt));
}

/**
 * Total ACTUAL labor cost for a job (sum of closed entries' snapshotted
 * laborCostCents). Open entries contribute 0. Feeds the admin invoice's actual-
 * vs-estimated margin readout. Reuses the pure rollup.
 */
export async function getActualLaborCostCents(
  organizationId: string,
  serviceRequestId: string,
): Promise<number> {
  const rows = await listTimeEntries(organizationId, serviceRequestId);
  return rollUpActualLaborCost(rows);
}
