/**
 * Account read-tools for the chat bot (safe v1 capability set).
 *
 * Each function answers an ACCOUNT-SPECIFIC question for a customer the chat
 * session has ALREADY identified (session.customerId, or a customer resolved
 * this turn via lookupCustomerContext). The chat route enforces that identity
 * gate BEFORE calling any of these — these functions trust their (orgId,
 * customerId) inputs and never resolve identity themselves. That keeps the
 * leak-prevention in one place (the route) and these as pure-ish, scoped reads.
 *
 * GUARDRAILS honored here:
 *  - Multi-tenant: every query is scoped by BOTH organizationId AND customerId
 *    (withTenant + an explicit customerId predicate), so one customer's data can
 *    never surface for another, and one tenant's data can never surface for
 *    another.
 *  - Money stays in integer cents; formatting to dollars happens at the reply
 *    layer (the chat route), not here — these return structured data.
 *  - never-promise-pricing: getOpenBalance reports an EXISTING invoice balance
 *    (a fact about a past transaction). It NEVER computes an estimate or a
 *    future/quoted price.
 *  - requestReschedule records a STAFF HAND-OFF (an internal request note) and
 *    NEVER mutates the schedule (no status / scheduledDate / arrival-window
 *    write). The bot must not self-book or self-reschedule.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerMemberships,
  membershipPlans,
  membershipVisits,
  invoices,
  serviceRequests,
  requestNotes,
  customers,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

/** Active membership summary for an identified customer. */
export interface MembershipSummary {
  readonly isMember: boolean;
  /** The plan name, when an active membership exists. */
  readonly planName: string | null;
  /** Billing cadence of the active plan ("monthly" | "annual"), when known. */
  readonly billingPeriod: string | null;
  /** End of the current paid period, when tracked. */
  readonly currentPeriodEnd: Date | null;
}

/** The next entitled maintenance visit for an identified customer. */
export interface NextVisit {
  /** When the visit is due. */
  readonly dueDate: Date;
  /** Visit lifecycle status ("scheduled" | "generated"). */
  readonly status: string;
}

/** Open-balance summary for an identified customer. Money in CENTS. */
export interface OpenBalance {
  /** Sum of (totalCents - amountPaidCents) over OPEN invoices. >= 0. */
  readonly balanceCents: number;
  /** Number of open invoices contributing to the balance. */
  readonly openInvoiceCount: number;
  /** True when the customer has an active self-service portal link. */
  readonly hasPortalLink: boolean;
}

/** The customer's soonest upcoming appointment. */
export interface UpcomingAppointment {
  readonly referenceNumber: string;
  readonly status: string;
  readonly scheduledDate: Date | null;
  readonly arrivalWindowStart: Date | null;
  readonly arrivalWindowEnd: Date | null;
}

/** Result of recording a reschedule hand-off for staff. */
export interface RescheduleHandoff {
  /** True when a staff note was recorded against an upcoming request. */
  readonly recorded: boolean;
  /** The request the hand-off was attached to, when one was found. */
  readonly referenceNumber: string | null;
}

/** Request statuses considered "upcoming" (not terminal). */
const UPCOMING_STATUSES = [
  "pending",
  "assigned",
  "scheduled",
  "in_progress",
  "on_hold",
] as const;

/**
 * Active membership + plan name for an identified customer, or a not-a-member
 * result. Reads the AUTHORITATIVE customer_memberships table (status='active'),
 * not the derived cache on customers.membershipStatus. At most one active
 * membership exists per (org, customer) — guarded by a partial unique index — so
 * we take the first.
 */
export async function getMembershipSummary(
  organizationId: string,
  customerId: string,
): Promise<MembershipSummary> {
  const [row] = await db
    .select({
      planName: membershipPlans.name,
      billingPeriod: membershipPlans.billingPeriod,
      currentPeriodEnd: customerMemberships.currentPeriodEnd,
    })
    .from(customerMemberships)
    .innerJoin(
      membershipPlans,
      eq(membershipPlans.id, customerMemberships.planId),
    )
    .where(
      withTenant(
        customerMemberships,
        organizationId,
        eq(customerMemberships.customerId, customerId),
        eq(customerMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      isMember: false,
      planName: null,
      billingPeriod: null,
      currentPeriodEnd: null,
    };
  }
  return {
    isMember: true,
    planName: row.planName,
    billingPeriod: row.billingPeriod,
    currentPeriodEnd: row.currentPeriodEnd ?? null,
  };
}

/**
 * The customer's NEXT entitled maintenance visit (soonest due date that hasn't
 * passed and isn't completed/skipped). Scoped to the customer's own memberships
 * via a correlated subquery, then org-scoped on the visits table — so a visit
 * from another customer or another tenant can never be returned. Returns null
 * when the customer has no upcoming visit.
 */
export async function getNextVisit(
  organizationId: string,
  customerId: string,
): Promise<NextVisit | null> {
  const now = new Date();
  const [row] = await db
    .select({
      dueDate: membershipVisits.dueDate,
      status: membershipVisits.status,
    })
    .from(membershipVisits)
    .innerJoin(
      customerMemberships,
      eq(customerMemberships.id, membershipVisits.customerMembershipId),
    )
    .where(
      and(
        withTenant(
          membershipVisits,
          organizationId,
          gte(membershipVisits.dueDate, now),
          inArray(membershipVisits.status, ["scheduled", "generated"]),
        ),
        // Scope to THIS customer's memberships (defense in depth alongside the
        // org filter on both joined tables).
        eq(customerMemberships.customerId, customerId),
        eq(customerMemberships.organizationId, organizationId),
      ),
    )
    .orderBy(membershipVisits.dueDate)
    .limit(1);

  if (!row) return null;
  return { dueDate: row.dueDate, status: row.status };
}

/**
 * The customer's OPEN balance in cents: the sum of (totalCents - amountPaidCents)
 * over invoices in state 'open'. Paid / void / draft / refunded invoices are
 * EXCLUDED (only 'open' contributes), so the figure is what the customer
 * currently owes on issued, unpaid invoices. Clamped at >= 0 (an overpaid
 * invoice never makes the total negative). Also reports whether an active portal
 * link exists, so the reply can offer it (without minting a new token here).
 */
export async function getOpenBalance(
  organizationId: string,
  customerId: string,
): Promise<OpenBalance> {
  // Two minimal, customer-scoped reads run atomically (neon-http has no
  // interactive transactions — db.batch is the atomic primitive):
  //  1. The open-invoice balance aggregate.
  //  2. A boolean: does the customer have an active portal link? (We only report
  //     that one exists — we never mint a token here.)
  const [aggRows, portalRows] = await db.batch([
    db
      .select({
        balanceCents: sql<number>`COALESCE(SUM(
          GREATEST(${invoices.totalCents} - ${invoices.amountPaidCents}, 0)
        ), 0)::int`,
        openInvoiceCount: sql<number>`COUNT(*)::int`,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          eq(invoices.customerId, customerId),
          eq(invoices.state, "open"),
        ),
      ),
    db
      .select({ portalTokenHash: customers.portalTokenHash })
      .from(customers)
      .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
      .limit(1),
  ]);

  const agg = aggRows[0];
  const portal = portalRows[0];

  return {
    balanceCents: Number(agg?.balanceCents ?? 0),
    openInvoiceCount: Number(agg?.openInvoiceCount ?? 0),
    hasPortalLink: Boolean(portal?.portalTokenHash),
  };
}

/**
 * The customer's soonest UPCOMING appointment: the non-terminal service request
 * with the earliest scheduledDate (NULLS last, so a not-yet-scheduled pending
 * request still surfaces after any dated one). Org + customer scoped. Returns
 * null when the customer has no upcoming request.
 */
export async function getUpcomingAppointment(
  organizationId: string,
  customerId: string,
): Promise<UpcomingAppointment | null> {
  const [row] = await db
    .select({
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.customerId, customerId),
        inArray(serviceRequests.status, [...UPCOMING_STATUSES]),
      ),
    )
    // Soonest dated job first; undated (pending) rows sort last via the CASE.
    .orderBy(
      sql`CASE WHEN ${serviceRequests.scheduledDate} IS NULL THEN 1 ELSE 0 END`,
      serviceRequests.scheduledDate,
      desc(serviceRequests.createdAt),
    )
    .limit(1);

  if (!row) return null;
  return {
    referenceNumber: row.referenceNumber,
    status: row.status,
    scheduledDate: row.scheduledDate ?? null,
    arrivalWindowStart: row.arrivalWindowStart ?? null,
    arrivalWindowEnd: row.arrivalWindowEnd ?? null,
  };
}

/**
 * Record a RESCHEDULE HAND-OFF for staff against the customer's upcoming request.
 *
 * This is NOT a booking and NOT a schedule mutation: it writes a single internal
 * request_note (staff-only, never shown to the customer) so a human follows up.
 * It deliberately does NOT touch status, scheduledDate, or the arrival window —
 * the bot can request a change, never make one.
 *
 * Returns recorded=false when the customer has no upcoming request to attach the
 * note to (the caller then tells the customer a human will reach out anyway).
 * authorId is left null: the note's author is the bot/customer, not a staff user.
 */
export async function requestReschedule(
  organizationId: string,
  customerId: string,
  detail: string | null,
): Promise<RescheduleHandoff> {
  const appointment = await getUpcomingAppointment(organizationId, customerId);
  if (!appointment) {
    return { recorded: false, referenceNumber: null };
  }

  // Re-resolve the request id scoped to org + customer + reference (never trust
  // an id from outside this function); the reference is unique.
  const [target] = await db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.customerId, customerId),
        eq(serviceRequests.referenceNumber, appointment.referenceNumber),
      ),
    )
    .limit(1);

  if (!target) {
    return { recorded: false, referenceNumber: null };
  }

  // Sanitize/clamp the customer-supplied detail before storing it in a note.
  const trimmed = (detail ?? "").trim().slice(0, 500);
  const content =
    "Reschedule requested by customer via chat." +
    (trimmed.length > 0 ? ` Customer note: ${trimmed}` : "");

  await db.insert(requestNotes).values({
    requestId: target.id,
    organizationId,
    authorId: null,
    content,
  });

  return { recorded: true, referenceNumber: appointment.referenceNumber };
}
