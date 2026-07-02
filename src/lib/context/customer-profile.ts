/**
 * Unified customer context layer — the single 360° read of a customer.
 *
 * The admin CRM's getCustomerById returns only basic identity + equipment/notes
 * and HARDCODES lastServiceDate = null; it says nothing about money, memberships,
 * or open estimates. Dispatch signals, agents, and the customer-detail view each
 * need the *connected* picture. loadCustomerProfile assembles it from the existing
 * tables in ONE call, tenant-scoped, with the independent reads parallelized.
 *
 * Every read is org-scoped via withTenant AND customer-scoped, so a profile can
 * never surface another tenant's (or another customer's) rows. Money is integer
 * cents throughout, matching the invoices/estimates schema.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerMemberships,
  customers,
  estimates,
  invoices,
  membershipPlans,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";

/** Decrypt a nullable ciphertext column, tolerating undecryptable/legacy rows. */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** How many recent jobs the profile carries (PII-light summary rows). */
const RECENT_JOBS_LIMIT = 5;

export interface ProfileMembership {
  readonly id: string;
  readonly planId: string;
  readonly planName: string;
  /** Enrollment status from customer_memberships (authoritative). */
  readonly status: string;
  readonly billingPeriod: string;
  readonly priceCents: number;
  readonly startedAt: string;
  readonly currentPeriodEnd: string | null;
}

export interface ProfileRecentJob {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly issueType: string;
  readonly createdAt: string;
  readonly scheduledDate: string | null;
  readonly completedAt: string | null;
}

export interface CustomerProfile {
  readonly customer: {
    readonly id: string;
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly address: string | null;
    readonly customerType: string;
    /** Derived cache on customers; the memberships array is authoritative. */
    readonly membershipStatus: string;
    readonly doNotService: boolean;
    readonly createdAt: string;
  };
  /** Active enrollment(s) joined to their plan. Empty when the customer has none. */
  readonly memberships: readonly ProfileMembership[];
  /** Sum of (total − amount paid) over OPEN invoices, in cents. 0 when nothing owed. */
  readonly balanceDueCents: number;
  /** How many invoices are in the 'open' (issued, not fully paid) state. */
  readonly openInvoiceCount: number;
  /** Most recent COMPLETED service request's completion time (ISO), or null. */
  readonly lastServiceDate: string | null;
  readonly openEstimates: {
    readonly count: number;
    readonly totalCents: number;
  };
  /** The last few service requests, newest first. Non-PII summary fields only. */
  readonly recentJobs: readonly ProfileRecentJob[];
}

/**
 * Assemble the unified 360° profile for one customer within one org.
 *
 * Returns null when the customer does not exist in the given org (the tenant
 * gate — a wrong-tenant customerId reads as "not found", never another org's row).
 *
 * All six reads are dispatched in a single Promise.all so the aggregation is one
 * round of parallel queries rather than an N+1 walk:
 *   - identity:      customers row (decrypted name/phone/email/address)
 *   - memberships:   customer_memberships ⋈ membership_plans, status='active'
 *   - balanceDue:    Σ(invoices.total_cents − invoices.amount_paid_cents) where state='open'
 *   - lastService:   MAX(service_requests.completed_at) where status='completed'
 *   - openEstimates: COUNT / Σ(estimates.total_cents) where status='open'
 *   - recentJobs:    last N service_requests, newest first (PII-light)
 */
export async function loadCustomerProfile(
  organizationId: string,
  customerId: string,
): Promise<CustomerProfile | null> {
  const [
    identityRows,
    membershipRows,
    balanceRows,
    lastServiceRows,
    openEstimateRows,
    recentJobRows,
  ] = await Promise.all([
    // Identity — the tenant + existence gate.
    db
      .select({
        id: customers.id,
        nameEncrypted: customers.nameEncrypted,
        phoneEncrypted: customers.phoneEncrypted,
        emailEncrypted: customers.emailEncrypted,
        addressEncrypted: customers.addressEncrypted,
        customerType: customers.customerType,
        membershipStatus: customers.membershipStatus,
        doNotService: customers.doNotService,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
      .limit(1),

    // Active membership(s), joined to the plan for name/price/period.
    db
      .select({
        id: customerMemberships.id,
        planId: customerMemberships.planId,
        status: customerMemberships.status,
        startedAt: customerMemberships.startedAt,
        currentPeriodEnd: customerMemberships.currentPeriodEnd,
        planName: membershipPlans.name,
        billingPeriod: membershipPlans.billingPeriod,
        priceCents: membershipPlans.priceCents,
      })
      .from(customerMemberships)
      .innerJoin(
        membershipPlans,
        // Re-assert the plan's org on the join (defense-in-depth): a malformed
        // membership row pointing at another tenant's plan can't leak its name/price.
        and(
          eq(customerMemberships.planId, membershipPlans.id),
          eq(membershipPlans.organizationId, organizationId),
        ),
      )
      .where(
        withTenant(
          customerMemberships,
          organizationId,
          eq(customerMemberships.customerId, customerId),
          eq(customerMemberships.status, "active"),
        ),
      )
      .orderBy(desc(customerMemberships.startedAt)),

    // Outstanding balance: only 'open' invoices are issued-and-owed. Draft isn't
    // issued yet; paid/void/refunded owe nothing. The remainder is total − paid.
    db
      .select({
        balanceDueCents: sql<number>`COALESCE(SUM(${invoices.totalCents} - ${invoices.amountPaidCents}), 0)::int`,
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

    // Last service = when the most recent COMPLETED request was completed. The
    // status→completed transition always stamps completed_at, so MAX is reliable.
    db
      .select({
        lastServiceDate: sql<string | null>`MAX(${serviceRequests.completedAt})::text`,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.customerId, customerId),
          eq(serviceRequests.status, "completed"),
        ),
      ),

    // Open (unsold) estimates: count + quoted total.
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${estimates.totalCents}), 0)::int`,
      })
      .from(estimates)
      .where(
        withTenant(
          estimates,
          organizationId,
          eq(estimates.customerId, customerId),
          eq(estimates.status, "open"),
        ),
      ),

    // Recent jobs — PII-light summary rows, newest first.
    db
      .select({
        id: serviceRequests.id,
        referenceNumber: serviceRequests.referenceNumber,
        status: serviceRequests.status,
        issueType: serviceRequests.issueType,
        createdAt: serviceRequests.createdAt,
        scheduledDate: serviceRequests.scheduledDate,
        completedAt: serviceRequests.completedAt,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.customerId, customerId),
        ),
      )
      .orderBy(desc(serviceRequests.createdAt))
      .limit(RECENT_JOBS_LIMIT),
  ]);

  const identity = identityRows[0];
  if (!identity) return null;

  const balance = balanceRows[0];
  const openEstimates = openEstimateRows[0];

  return {
    customer: {
      id: identity.id,
      name: safeDecrypt(identity.nameEncrypted),
      phone: safeDecrypt(identity.phoneEncrypted),
      email: safeDecrypt(identity.emailEncrypted),
      address: safeDecrypt(identity.addressEncrypted),
      customerType: identity.customerType,
      membershipStatus: identity.membershipStatus,
      doNotService: identity.doNotService,
      createdAt: identity.createdAt.toISOString(),
    },
    memberships: membershipRows.map((m) => ({
      id: m.id,
      planId: m.planId,
      planName: m.planName,
      status: m.status,
      billingPeriod: m.billingPeriod,
      priceCents: m.priceCents,
      startedAt: m.startedAt.toISOString(),
      currentPeriodEnd: m.currentPeriodEnd?.toISOString() ?? null,
    })),
    balanceDueCents: balance?.balanceDueCents ?? 0,
    openInvoiceCount: balance?.openInvoiceCount ?? 0,
    lastServiceDate: lastServiceRows[0]?.lastServiceDate ?? null,
    openEstimates: {
      count: openEstimates?.count ?? 0,
      totalCents: openEstimates?.totalCents ?? 0,
    },
    recentJobs: recentJobRows.map((j) => ({
      id: j.id,
      referenceNumber: j.referenceNumber,
      status: j.status,
      issueType: j.issueType,
      createdAt: j.createdAt.toISOString(),
      scheduledDate: j.scheduledDate?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
  };
}
