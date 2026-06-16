/**
 * Recurring / membership maintenance visit generation (ServiceTitan service-
 * agreement parity).
 *
 * Members on a plan with visitsPerYear>0 are OWED scheduled maintenance visits.
 * This module computes the due visits for a membership's current cycle and, on a
 * DAILY cron, materializes the ones coming due into real `service_requests` (so
 * a generated maintenance call looks exactly like a booked job to dispatch and
 * the dashboard).
 *
 * IDEMPOTENCY: generation is guarded by the (customerMembershipId, periodKey)
 * UNIQUE index on `membership_visits`, NOT a read-then-write. The visit row is
 * inserted with onConflictDoNothing; only the caller that actually inserts the
 * row goes on to create the job, so a retried/concurrent daily cron can never
 * double-generate. The cron computes "due within a window" (not "due today
 * exactly") so a one-shot daily run that misses a day still catches up.
 *
 * AUTHORITATIVE state: visits are generated ONLY for customerMemberships with
 * status='active' (never the derived customers.membershipStatus cache).
 *
 * neon-http has NO interactive transactions, so the system session + visit row +
 * service request + back-link all go through a single db.batch (executed as one
 * non-interactive transaction).
 *
 * Every write is scoped by the row's OWN organizationId — the cron has no
 * session, so it must never do a global unscoped write.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerMemberships,
  customers,
  membershipPlans,
  membershipVisits,
  customerSessions,
  serviceRequests,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

export interface MembershipVisitRow {
  readonly id: string;
  readonly dueDate: Date;
  readonly periodKey: string;
  readonly status: string;
  readonly generatedServiceRequestId: string | null;
}

/**
 * Read-only list of a membership's visits (upcoming + generated), oldest due
 * first. For the customer detail membership card. Org-scoped.
 */
export async function listVisitsForMembership(
  organizationId: string,
  customerMembershipId: string,
): Promise<readonly MembershipVisitRow[]> {
  return db
    .select({
      id: membershipVisits.id,
      dueDate: membershipVisits.dueDate,
      periodKey: membershipVisits.periodKey,
      status: membershipVisits.status,
      generatedServiceRequestId: membershipVisits.generatedServiceRequestId,
    })
    .from(membershipVisits)
    .where(
      and(
        eq(membershipVisits.organizationId, organizationId),
        eq(membershipVisits.customerMembershipId, customerMembershipId),
      ),
    )
    .orderBy(asc(membershipVisits.dueDate));
}

export interface PlannedVisit {
  /** Idempotency bucket within the cycle, e.g. "2026-H1". */
  readonly periodKey: string;
  /** When the visit is due. */
  readonly dueDate: Date;
}

export interface MembershipForPlanning {
  readonly id: string;
  readonly startedAt: Date;
  readonly currentPeriodEnd: Date | null;
}

export interface PlanForPlanning {
  readonly visitsPerYear: number;
}

/**
 * Compute the maintenance visits a membership is owed in its CURRENT annual
 * cycle, spread evenly across the year from the anniversary of `startedAt`.
 *
 * Pure (no I/O). Returns one PlannedVisit per entitled visit with a stable
 * periodKey ("<cycleYear>-V<n>") so the same visit always maps to the same
 * idempotency bucket regardless of when the cron runs.
 *
 * The cycle is the 12-month window starting at the most recent anniversary of
 * `startedAt` on/before `now` — so a long-lived membership keeps generating
 * fresh visits each year without the keys ever colliding across cycles.
 */
export function planVisitsForMembership(
  _organizationId: string,
  membership: MembershipForPlanning,
  plan: PlanForPlanning,
  now: Date,
): readonly PlannedVisit[] {
  if (plan.visitsPerYear <= 0) return [];

  const cycleStart = currentCycleStart(membership.startedAt, now);
  const cycleYear = cycleStart.getUTCFullYear();
  // Even spacing: for N visits/year, place them at month 0, 12/N, 24/N, ...
  const monthStep = 12 / plan.visitsPerYear;

  const visits: PlannedVisit[] = [];
  for (let n = 0; n < plan.visitsPerYear; n++) {
    const dueDate = addMonths(cycleStart, Math.round(n * monthStep));
    visits.push({
      periodKey: `${cycleYear}-V${n + 1}`,
      dueDate,
    });
  }
  return visits;
}

/** Start of the 12-month cycle containing `now`, anchored on startedAt's anniversary. */
function currentCycleStart(startedAt: Date, now: Date): Date {
  const start = new Date(startedAt);
  // Walk anniversaries forward from startedAt until the next one would pass now.
  const cursor = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
    ),
  );
  // If this year's anniversary is still in the future, the current cycle began
  // last year's anniversary.
  if (cursor.getTime() > now.getTime()) {
    cursor.setUTCFullYear(cursor.getUTCFullYear() - 1);
  }
  // Never return a cycle start before the membership existed.
  return cursor.getTime() < start.getTime() ? start : cursor;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

interface ActiveMembershipRow {
  readonly membershipId: string;
  readonly startedAt: Date;
  readonly currentPeriodEnd: Date | null;
  readonly customerId: string;
  readonly visitsPerYear: number;
  readonly planName: string;
  readonly customerNameEncrypted: string;
  readonly customerAddressEncrypted: string | null;
}

export interface GenerateDueVisitsResult {
  /** Visits newly materialized into service requests on this run. */
  readonly generated: number;
  /** Active membership rows considered (plan.visitsPerYear>0). */
  readonly scanned: number;
}

/**
 * For one org, materialize the maintenance visits coming due within `withinDays`
 * that haven't been generated yet. Idempotent and safe to re-run daily.
 *
 * @param organizationId scope — every read/write is constrained to this org.
 * @param now the reference instant (injectable for tests).
 * @param opts.withinDays how far ahead to look for due visits (window).
 */
export async function generateDueVisits(
  organizationId: string,
  now: Date,
  opts: { readonly withinDays: number },
): Promise<GenerateDueVisitsResult> {
  const windowEnd = new Date(now.getTime() + opts.withinDays * 24 * 60 * 60 * 1000);

  // AUTHORITATIVE read: active customerMemberships (NOT customers.membershipStatus)
  // joined to their plan (visitsPerYear>0) and customer (for the encrypted
  // contact blobs we copy onto the generated job). Scoped to this org.
  const rows: ActiveMembershipRow[] = await db
    .select({
      membershipId: customerMemberships.id,
      startedAt: customerMemberships.startedAt,
      currentPeriodEnd: customerMemberships.currentPeriodEnd,
      customerId: customerMemberships.customerId,
      visitsPerYear: membershipPlans.visitsPerYear,
      planName: membershipPlans.name,
      customerNameEncrypted: customers.nameEncrypted,
      customerAddressEncrypted: customers.addressEncrypted,
    })
    .from(customerMemberships)
    .innerJoin(membershipPlans, eq(customerMemberships.planId, membershipPlans.id))
    .innerJoin(customers, eq(customerMemberships.customerId, customers.id))
    .where(
      and(
        eq(customerMemberships.organizationId, organizationId),
        eq(customerMemberships.status, "active"),
        gt(membershipPlans.visitsPerYear, 0),
      ),
    );

  let generated = 0;

  for (const row of rows) {
    const planned = planVisitsForMembership(
      organizationId,
      {
        id: row.membershipId,
        startedAt: row.startedAt,
        currentPeriodEnd: row.currentPeriodEnd,
      },
      { visitsPerYear: row.visitsPerYear },
      now,
    );

    // Only the visits coming due inside the window. "due within N days", never
    // "due today exactly", so a daily cron that skips a run still catches up.
    const due = planned.filter(
      (v) => v.dueDate.getTime() <= windowEnd.getTime(),
    );
    if (due.length === 0) continue;

    // Skip periods already fully GENERATED (cheap pre-filter; the unique index
    // is the real guard against a concurrent double-generate). A row that was
    // claimed but stranded at status='scheduled' (a prior run crashed between
    // claim and job creation) is intentionally NOT skipped — generateOneVisit
    // re-drives it to 'generated', so the cron self-heals.
    const existing = await db
      .select({ periodKey: membershipVisits.periodKey })
      .from(membershipVisits)
      .where(
        and(
          eq(membershipVisits.organizationId, organizationId),
          eq(membershipVisits.customerMembershipId, row.membershipId),
          eq(membershipVisits.status, "generated"),
          inArray(
            membershipVisits.periodKey,
            due.map((v) => v.periodKey),
          ),
        ),
      );
    const alreadyDone = new Set(existing.map((e) => e.periodKey));

    for (const visit of due) {
      if (alreadyDone.has(visit.periodKey)) continue;
      const ok = await generateOneVisit(organizationId, row, visit, now);
      if (ok) generated += 1;
    }
  }

  return { generated, scanned: rows.length };
}

/** Format: HVAC-XXXXXXXX (mirrors submit-session-request.generateReferenceNumber). */
function generateReferenceNumber(): string {
  return `HVAC-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Materialize a single planned visit: a system intake session + the visit row +
 * a maintenance service_request, all in ONE db.batch. Returns false (no error)
 * when the (membership, periodKey) slot was already claimed — the unique index
 * makes the visit insert the atomic idempotency guard.
 */
async function generateOneVisit(
  organizationId: string,
  row: ActiveMembershipRow,
  visit: PlannedVisit,
  now: Date,
): Promise<boolean> {
  // Claim the (membership, periodKey) slot first. onConflictDoNothing → the row
  // is inserted exactly once; a concurrent/retried run gets an empty result.
  const newVisitId = randomUUID();
  const claimed = await db
    .insert(membershipVisits)
    .values({
      id: newVisitId,
      organizationId,
      customerMembershipId: row.membershipId,
      dueDate: visit.dueDate,
      periodKey: visit.periodKey,
      status: "scheduled",
    })
    .onConflictDoNothing({
      target: [
        membershipVisits.customerMembershipId,
        membershipVisits.periodKey,
      ],
    })
    .returning({ id: membershipVisits.id });

  let visitId: string;
  if (claimed.length > 0) {
    visitId = claimed[0]!.id;
  } else {
    // The slot already exists. If it's already GENERATED, a concurrent run won;
    // skip. Otherwise it was stranded at 'scheduled' by a crashed prior run —
    // recover it by re-driving job creation against the existing row.
    const [existing] = await db
      .select({ id: membershipVisits.id, status: membershipVisits.status })
      .from(membershipVisits)
      .where(
        and(
          eq(membershipVisits.organizationId, organizationId),
          eq(membershipVisits.customerMembershipId, row.membershipId),
          eq(membershipVisits.periodKey, visit.periodKey),
        ),
      )
      .limit(1);
    if (!existing || existing.status === "generated") return false;
    visitId = existing.id;
  }

  // service_requests.sessionId is NOT NULL, so a generated job needs a session.
  // There is no human intake conversation, so create a synthetic "system"
  // session for it (channel=web, status=submitted) in the same batch.
  const sessionId = randomUUID();
  const serviceRequestId = randomUUID();
  const referenceNumber = generateReferenceNumber();

  try {
    await db.batch([
      db.insert(customerSessions).values({
        id: sessionId,
        organizationId,
        token: `mvisit-${sessionId}`,
        status: "submitted",
        channel: "web",
        customerId: row.customerId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(serviceRequests).values({
        id: serviceRequestId,
        organizationId,
        sessionId,
        customerId: row.customerId,
        status: "scheduled",
        issueType: "Membership maintenance visit",
        jobType: "maintenance",
        urgency: "low",
        description: `Scheduled maintenance visit (${row.planName} membership).`,
        // Copy the customer's already-encrypted contact blobs straight across —
        // same AES key + self-contained IV, so no decrypt/re-encrypt is needed.
        customerNameEncrypted: row.customerNameEncrypted,
        addressEncrypted: row.customerAddressEncrypted,
        referenceNumber,
        scheduledDate: visit.dueDate,
        leadSource: "repeat_customer",
      }),
      db
        .update(membershipVisits)
        .set({
          status: "generated",
          generatedServiceRequestId: serviceRequestId,
          updatedAt: now,
        })
        .where(
          and(
            eq(membershipVisits.id, visitId),
            eq(membershipVisits.organizationId, organizationId),
          ),
        ),
    ]);
    return true;
  } catch (err: unknown) {
    // The slot is claimed (status='scheduled') but job creation failed. Leave
    // the row — a later run sees status!='generated' is irrelevant (the pre-
    // filter keys off existence), so log for visibility. No PII (ids only).
    logger.error(
      { error: err, organizationId, membershipId: row.membershipId, visitId },
      "Failed to materialize membership maintenance visit",
    );
    return false;
  }
}
