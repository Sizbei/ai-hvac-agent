import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getPlan, type Plan, type PlanEntitlements } from "./plans";

/**
 * Entitlement resolution + the org-active gate (Stage 10).
 *
 * `getOrgEntitlements(orgId)` reads `organizations.plan` and maps it to that
 * tier's entitlements (a NULL plan → the default/free tier, never "unlimited").
 * `isOrgActive(org)` is the single source of truth for whether an org's
 * subscription is in good standing — it drives the suspended banner and the seat
 * gate. Both are degrade-safe: an unknown plan id falls back to the free tier.
 */

/** Org-status shape isOrgActive needs (a session/org row, not the whole table). */
export interface OrgStatusLike {
  readonly status: "active" | "trial" | "past_due" | "suspended";
}

/**
 * Whether an org's subscription is in good standing.
 *
 *   active / trial → true  (trial is a paid-grace period; full access)
 *   past_due       → false (payment failed — dunning; gate + banner)
 *   suspended      → false (cancelled/deleted — gate + banner)
 *
 * Pure (no DB) so callers that already hold the org/session row don't re-query.
 */
export function isOrgActive(org: OrgStatusLike): boolean {
  return org.status === "active" || org.status === "trial";
}

export interface OrgEntitlements {
  readonly plan: Plan;
  readonly entitlements: PlanEntitlements;
}

/**
 * Resolve the entitlements for an org by reading its plan column. NULL/unknown
 * plan → the default/free tier. Throws only if the org id does not exist (a
 * caller bug); a legacy org with a NULL plan resolves cleanly to free.
 */
export async function getOrgEntitlements(
  orgId: string,
): Promise<OrgEntitlements> {
  const [row] = await db
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!row) {
    throw new Error(`Organization not found: ${orgId}`);
  }

  const plan = getPlan(row.plan);
  return { plan, entitlements: plan.entitlements };
}
