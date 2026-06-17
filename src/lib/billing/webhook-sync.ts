import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, saasBillingEvents, auditLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { isValidPlanId } from "./plans";

/**
 * SaaS-billing webhook application (Stage 10) — mock-driven until a real Stripe
 * adapter lands. Maps a subscription-lifecycle event onto
 * organizations.plan / status / currentPeriodEnd, IDEMPOTENTLY (deduped on the
 * provider event id) so a redelivery never double-applies.
 *
 * The accepted payload shape (test/mock world; a real Stripe adapter would parse
 * Stripe's event envelope here instead):
 *
 *   {
 *     id:     string,                 // provider event id (dedupe key)
 *     type:   "subscription.created" | "subscription.updated"
 *           | "subscription.deleted" | "payment_failed",
 *     orgId:  string (uuid),          // the org the subscription belongs to
 *     planId?: string,                // required for created/updated
 *     currentPeriodEnd?: string,      // ISO; optional
 *     status?: "active"|"trial"|"past_due"|"suspended" // optional explicit override
 *   }
 *
 * Lifecycle → org mapping (when `status` is not explicitly provided):
 *   subscription.created/updated → status "active", plan = planId
 *   subscription.deleted         → status "suspended", plan cleared (→ free)
 *   payment_failed               → status "past_due" (plan unchanged; dunning)
 */

export type BillingEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.deleted"
  | "payment_failed";

const EVENT_TYPES: readonly BillingEventType[] = [
  "subscription.created",
  "subscription.updated",
  "subscription.deleted",
  "payment_failed",
];

const STATUSES = ["active", "trial", "past_due", "suspended"] as const;
type OrgStatus = (typeof STATUSES)[number];

export interface BillingWebhookEvent {
  readonly id: string;
  readonly type: BillingEventType;
  readonly orgId: string;
  readonly planId?: string;
  readonly currentPeriodEnd?: string;
  readonly status?: OrgStatus;
}

export type BillingApplyOutcome =
  | "applied"
  | "duplicate"
  | "unknown_org"
  | "invalid_plan";

export interface BillingApplyResult {
  readonly outcome: BillingApplyOutcome;
}

/**
 * Validate/normalize an untrusted parsed payload into a BillingWebhookEvent, or
 * null when it is malformed. Boundary validation — never trust the body.
 */
export function parseBillingEvent(body: unknown): BillingWebhookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;

  const id = typeof o.id === "string" ? o.id.trim() : "";
  const type = typeof o.type === "string" ? o.type : "";
  const orgId = typeof o.orgId === "string" ? o.orgId.trim() : "";

  if (id.length === 0 || orgId.length === 0) return null;
  if (!EVENT_TYPES.includes(type as BillingEventType)) return null;

  const planId = typeof o.planId === "string" ? o.planId : undefined;
  const currentPeriodEnd =
    typeof o.currentPeriodEnd === "string" ? o.currentPeriodEnd : undefined;
  const status =
    typeof o.status === "string" && STATUSES.includes(o.status as OrgStatus)
      ? (o.status as OrgStatus)
      : undefined;

  return {
    id,
    type: type as BillingEventType,
    orgId,
    planId,
    currentPeriodEnd,
    status,
  };
}

/**
 * Record the event in the idempotency ledger. Returns true when THIS call
 * inserted the row (first delivery), false when it already existed (redelivery).
 * The global unique index on event_id makes this atomic across concurrent
 * redeliveries — exactly one insert wins.
 */
async function recordEventOnce(event: BillingWebhookEvent): Promise<boolean> {
  const inserted = await db
    .insert(saasBillingEvents)
    .values({
      eventId: event.id,
      eventType: event.type,
      // organizationId is nullable here ON PURPOSE: event.orgId is provider-
      // supplied and may name an org that does not exist (organizationId is a FK
      // to organizations). Inserting a non-existent id here would throw a FK
      // violation → 500 → the provider retries forever. We store null; the
      // dedupe key is event_id (unique), so idempotency is unaffected, and the
      // org context is still captured in the audit row when the org is real.
      organizationId: null,
    })
    .onConflictDoNothing({ target: [saasBillingEvents.eventId] })
    .returning({ id: saasBillingEvents.id });
  return inserted.length > 0;
}

/** Compensating delete of the ledger row, used ONLY when apply threw AFTER the
 * claim — so a retry can reprocess instead of being deduped forever. */
async function releaseEvent(event: BillingWebhookEvent): Promise<void> {
  await db
    .delete(saasBillingEvents)
    .where(eq(saasBillingEvents.eventId, event.id))
    .catch((error: unknown) => {
      logger.error(
        { error, eventId: event.id },
        "Failed to release saas-billing ledger row after a processing error",
      );
    });
}

/** Compute the (plan, status) the event implies (before any explicit override). */
function resolveTransition(event: BillingWebhookEvent): {
  status: OrgStatus;
  /** undefined => leave plan unchanged; null => clear plan (→ free). */
  plan: string | null | undefined;
} {
  switch (event.type) {
    case "subscription.created":
    case "subscription.updated":
      return { status: "active", plan: event.planId };
    case "subscription.deleted":
      return { status: "suspended", plan: null };
    case "payment_failed":
      return { status: "past_due", plan: undefined };
  }
}

/**
 * Apply one VERIFIED, parsed billing event to the org. Idempotent on the event
 * id; degrade-safe on every miss (unknown org / invalid plan → recorded + no-op).
 */
export async function applyBillingEvent(
  event: BillingWebhookEvent,
): Promise<BillingApplyResult> {
  // 1. Idempotency: only the FIRST delivery of this event id proceeds.
  const first = await recordEventOnce(event);
  if (!first) {
    return { outcome: "duplicate" };
  }

  try {
    // 2. Target org must exist.
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, event.orgId))
      .limit(1);
    if (!org) {
      // Recorded as seen (so a retry doesn't reprocess) but nothing to update.
      // No audit row: audit_log.organization_id is a FK and this org id is not a
      // real org, so an insert would violate it. The ledger row is the record.
      return { outcome: "unknown_org" };
    }

    const transition = resolveTransition(event);
    const status = event.status ?? transition.status;

    // 3. Validate any plan we'd set (created/updated). An unknown plan id is a
    // bad event — fail loudly rather than silently leaving the org on a stale tier.
    if (transition.plan !== undefined && transition.plan !== null) {
      if (!isValidPlanId(transition.plan)) {
        await auditBilling(event, "invalid_plan");
        // An unrecognized plan id may simply be a plan-catalog deploy that hasn't
        // landed yet. Release the ledger claim so a provider redelivery AFTER the
        // catalog ships can reprocess instead of being deduped forever. (The
        // audit row above is kept as the record of the miss.)
        await releaseEvent(event);
        logger.error(
          { eventId: event.id, planId: transition.plan },
          "SaaS-billing event references an unrecognized plan id; released for retry",
        );
        return { outcome: "invalid_plan" };
      }
    }

    // 4. Build the update. Only touch columns the transition speaks to.
    const updates: {
      status: OrgStatus;
      plan?: string | null;
      currentPeriodEnd?: Date | null;
      updatedAt: Date;
    } = { status, updatedAt: new Date() };

    if (transition.plan !== undefined) {
      updates.plan = transition.plan; // string (set) or null (clear → free)
    }
    if (event.currentPeriodEnd !== undefined) {
      const parsed = new Date(event.currentPeriodEnd);
      updates.currentPeriodEnd = Number.isNaN(parsed.getTime()) ? null : parsed;
    } else if (event.type === "subscription.deleted") {
      updates.currentPeriodEnd = null;
    }

    await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, event.orgId));

    await auditBilling(event, "applied");
    return { outcome: "applied" };
  } catch (error: unknown) {
    // Release the claim so the provider's retry can reprocess.
    await releaseEvent(event);
    logger.error(
      { error, eventId: event.id, organizationId: event.orgId },
      "Failed to apply saas-billing event",
    );
    throw error;
  }
}

/** Best-effort non-PII audit of a billing webhook outcome (ids/enums only). */
async function auditBilling(
  event: BillingWebhookEvent,
  outcome: BillingApplyOutcome,
): Promise<void> {
  await db
    .insert(auditLog)
    .values({
      organizationId: event.orgId,
      actorType: "system",
      action: "saas_billing_webhook",
      entity: "organization",
      entityId: event.orgId,
      details: JSON.stringify({
        eventId: event.id,
        eventType: event.type,
        planId: event.planId ?? null,
        outcome,
      }),
    })
    .catch((error: unknown) => {
      logger.error(
        { error, eventId: event.id },
        "Failed to audit saas-billing webhook",
      );
    });
}
