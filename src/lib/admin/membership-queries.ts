/**
 * Memberships v1 — plan CRUD + customer enrollment.
 *
 * `customerMemberships` is the AUTHORITATIVE source of a customer's membership
 * state. `customers.membershipStatus` is a DERIVED cache kept in sync inside the
 * SAME db.batch as enroll/cancel so existing member-aware readers (greeting,
 * priority) stay correct without a second source of truth.
 *
 * Recurring billing is STRIPE-GATED → mocked. Any period charge goes through
 * getPaymentProvider() (mock). v1 does NOT auto-renew: currentPeriodEnd is
 * tracked but renewals are not charged on a cron.
 *
 * Money in integer cents. Every query is org-scoped via withTenant.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerMemberships, customers, membershipPlans } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { getPaymentProvider, type PaymentProvider } from "@/lib/payments/provider";

export type MembershipBillingPeriod = "monthly" | "annual";

// ──────────────────────────── plan CRUD ────────────────────────────

export interface MembershipPlanInput {
  readonly name: string;
  readonly description?: string | null;
  readonly priceCents: number;
  readonly billingPeriod: MembershipBillingPeriod;
  /** Maintenance visits owed per year (0 = billing-only, no auto-generation). */
  readonly visitsPerYear?: number;
}

export interface MembershipPlanRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceCents: number;
  readonly billingPeriod: string;
  readonly visitsPerYear: number;
  readonly active: boolean;
}

const PLAN_PROJECTION = {
  id: membershipPlans.id,
  name: membershipPlans.name,
  description: membershipPlans.description,
  priceCents: membershipPlans.priceCents,
  billingPeriod: membershipPlans.billingPeriod,
  visitsPerYear: membershipPlans.visitsPerYear,
  active: membershipPlans.active,
} as const;

export async function createMembershipPlan(
  organizationId: string,
  input: MembershipPlanInput,
): Promise<string> {
  const [row] = await db
    .insert(membershipPlans)
    .values({
      organizationId,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      billingPeriod: input.billingPeriod,
      visitsPerYear: input.visitsPerYear ?? 0,
    })
    .returning({ id: membershipPlans.id });
  return row!.id;
}

/** Plans for an org (active only by default, default name ASC). */
export async function listMembershipPlans(
  organizationId: string,
  opts: { readonly includeInactive?: boolean } = {},
): Promise<readonly MembershipPlanRow[]> {
  const condition = opts.includeInactive
    ? withTenant(membershipPlans, organizationId)
    : withTenant(membershipPlans, organizationId, eq(membershipPlans.active, true));
  return db
    .select(PLAN_PROJECTION)
    .from(membershipPlans)
    .where(condition)
    .orderBy(asc(membershipPlans.name));
}

export async function getMembershipPlanById(
  organizationId: string,
  id: string,
): Promise<MembershipPlanRow | null> {
  const [row] = await db
    .select(PLAN_PROJECTION)
    .from(membershipPlans)
    .where(withTenant(membershipPlans, organizationId, eq(membershipPlans.id, id)))
    .limit(1);
  return row ?? null;
}

export type MembershipPlanUpdate = Partial<MembershipPlanInput>;

export async function updateMembershipPlan(
  organizationId: string,
  id: string,
  partial: MembershipPlanUpdate,
): Promise<void> {
  const setFields: Record<string, unknown> = {};
  if (partial.name !== undefined) setFields.name = partial.name;
  if (partial.description !== undefined) {
    setFields.description = partial.description ?? null;
  }
  if (partial.priceCents !== undefined) setFields.priceCents = partial.priceCents;
  if (partial.billingPeriod !== undefined) {
    setFields.billingPeriod = partial.billingPeriod;
  }
  if (partial.visitsPerYear !== undefined) {
    setFields.visitsPerYear = partial.visitsPerYear;
  }
  if (Object.keys(setFields).length === 0) return;
  await db
    .update(membershipPlans)
    .set({ ...setFields, updatedAt: new Date() })
    .where(withTenant(membershipPlans, organizationId, eq(membershipPlans.id, id)));
}

/** Soft delete — existing enrollments may reference the plan, so never hard delete. */
export async function deactivateMembershipPlan(
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(membershipPlans)
    .set({ active: false, updatedAt: new Date() })
    .where(withTenant(membershipPlans, organizationId, eq(membershipPlans.id, id)));
}

// ──────────────────────── enrollment / status ────────────────────────

/** Add one billing period to `from` (monthly = +1 month, annual = +1 year). */
function periodEnd(from: Date, billingPeriod: MembershipBillingPeriod): Date {
  const end = new Date(from);
  if (billingPeriod === "annual") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

export interface ActiveMembership {
  readonly id: string;
  readonly planId: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly currentPeriodEnd: Date | null;
  readonly plan: MembershipPlanRow;
}

/** The customer's active membership + its plan, or null when not a member. */
export async function getActiveMembership(
  organizationId: string,
  customerId: string,
): Promise<ActiveMembership | null> {
  const [row] = await db
    .select({
      id: customerMemberships.id,
      planId: customerMemberships.planId,
      status: customerMemberships.status,
      startedAt: customerMemberships.startedAt,
      currentPeriodEnd: customerMemberships.currentPeriodEnd,
      planName: membershipPlans.name,
      planDescription: membershipPlans.description,
      planPriceCents: membershipPlans.priceCents,
      planBillingPeriod: membershipPlans.billingPeriod,
      planVisitsPerYear: membershipPlans.visitsPerYear,
      planActive: membershipPlans.active,
    })
    .from(customerMemberships)
    .innerJoin(membershipPlans, eq(customerMemberships.planId, membershipPlans.id))
    .where(
      withTenant(
        customerMemberships,
        organizationId,
        eq(customerMemberships.customerId, customerId),
        eq(customerMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    planId: row.planId,
    status: row.status,
    startedAt: row.startedAt,
    currentPeriodEnd: row.currentPeriodEnd,
    plan: {
      id: row.planId,
      name: row.planName,
      description: row.planDescription,
      priceCents: row.planPriceCents,
      billingPeriod: row.planBillingPeriod,
      visitsPerYear: row.planVisitsPerYear,
      active: row.planActive,
    },
  };
}

export type EnrollResult =
  | { readonly ok: true; readonly membershipId: string }
  | {
      readonly ok: false;
      readonly reason: "plan_not_found" | "already_enrolled" | "charge_failed";
    };

/**
 * Enroll a customer in a plan. Verifies the plan belongs to the org and is
 * active, rejects a second active membership (the partial unique index is the
 * hard guard; this pre-check gives a clean error). Writes the membership row AND
 * derives customers.membershipStatus='active' in ONE db.batch.
 *
 * When chargeFirstPeriod, takes a MOCK charge (record-then-charge is overkill for
 * the mock) BEFORE the batch and gates enrollment on its success. The membership
 * id is the charge idempotencyKey so a retry is stable.
 */
export async function enrollCustomer(
  organizationId: string,
  customerId: string,
  planId: string,
  opts: { readonly chargeFirstPeriod?: boolean } = {},
  provider: PaymentProvider = getPaymentProvider(),
  now: Date = new Date(),
): Promise<EnrollResult> {
  const plan = await getMembershipPlanById(organizationId, planId);
  if (!plan || !plan.active) return { ok: false, reason: "plan_not_found" };

  const existing = await getActiveMembership(organizationId, customerId);
  if (existing) return { ok: false, reason: "already_enrolled" };

  const membershipId = randomUUID();

  if (opts.chargeFirstPeriod) {
    const charge = await provider.createCharge({
      amountCents: plan.priceCents,
      description: `Membership: ${plan.name}`,
      idempotencyKey: membershipId,
    });
    if (charge.status !== "succeeded") {
      return { ok: false, reason: "charge_failed" };
    }
  }

  const billingPeriod = plan.billingPeriod as MembershipBillingPeriod;

  // Authoritative insert + derived-cache update, batched. neon-http db.batch runs
  // sequentially (NOT a serializable transaction) — order is irrelevant here as
  // the two statements touch different tables. The partial unique index makes the
  // insert the atomic guard against a concurrent double-enroll.
  await db.batch([
    db.insert(customerMemberships).values({
      id: membershipId,
      organizationId,
      customerId,
      planId,
      status: "active",
      startedAt: now,
      currentPeriodEnd: periodEnd(now, billingPeriod),
    }),
    db
      .update(customers)
      .set({ membershipStatus: "active", updatedAt: now })
      .where(withTenant(customers, organizationId, eq(customers.id, customerId))),
  ]);

  return { ok: true, membershipId };
}

export type CancelResult =
  | { readonly ok: true; readonly cancelled: boolean }
  | { readonly ok: false; readonly reason: "not_a_member" };

/**
 * Cancel a customer's active membership: status→cancelled + cancelledAt, and
 * derive customers.membershipStatus='cancelled', in one db.batch. Idempotent —
 * a second cancel (no active membership) returns not_a_member without writing.
 */
export async function cancelMembership(
  organizationId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<CancelResult> {
  const active = await getActiveMembership(organizationId, customerId);
  if (!active) return { ok: false, reason: "not_a_member" };

  await db.batch([
    db
      .update(customerMemberships)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(
        withTenant(
          customerMemberships,
          organizationId,
          eq(customerMemberships.id, active.id),
        ),
      ),
    db
      .update(customers)
      .set({ membershipStatus: "cancelled", updatedAt: now })
      .where(withTenant(customers, organizationId, eq(customers.id, customerId))),
  ]);

  return { ok: true, cancelled: true };
}
