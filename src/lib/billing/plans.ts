/**
 * SaaS plan catalog (Stage 10).
 *
 * The platform's own subscription tiers — version-controlled CONFIG, not a DB
 * enum, so a new tier (or a price tweak) ships without a migration. An org's
 * `organizations.plan` column stores a plan id from here; a NULL plan means the
 * org is on the default/free tier (DEFAULT_PLAN below).
 *
 * Entitlements are the only thing the app enforces against (see
 * src/lib/billing/entitlements.ts). Prices are integer cents (the project-wide
 * money convention) and are PLACEHOLDER values — they are display-only until the
 * real Stripe adapter + real Price ids land in Stage 11/the billing follow-up.
 */

/** Billing cadence. Monthly only in v1. */
export type BillingInterval = "month";

export interface PlanEntitlements {
  /** Hard cap on active staff (admins + technicians) the org may have. */
  readonly maxStaff: number;
  /** Optional soft cap on customer conversations per calendar month. Omitted =
   * no conversation cap on that tier. (Not enforced in v1 — recorded so the
   * entitlement shape is complete; the seat gate is the v1 enforcement.) */
  readonly maxConversationsPerMonth?: number;
  /** Named feature flags the tier unlocks. Free-form, checked by name. */
  readonly features: readonly string[];
}

export interface Plan {
  /** Stable id stored in organizations.plan. Never change a shipped id. */
  readonly id: string;
  /** Human label for the billing UI. */
  readonly label: string;
  /** Price in integer cents for one `interval`. Placeholder until real Stripe. */
  readonly priceCents: number;
  readonly interval: BillingInterval;
  readonly entitlements: PlanEntitlements;
}

/**
 * The tier an org is on when `organizations.plan` is NULL (un-subscribed /
 * legacy / freshly-provisioned). Deliberately minimal so an un-billed org is
 * usable but bounded.
 *
 * NULL plan == free tier (maxStaff 2) — this is INTENDED for freshly-provisioned
 * orgs. BUT existing/legacy orgs created before billing shipped also have
 * plan=NULL and would be capped at 2 seats the moment this code deploys. Those
 * pre-billing orgs MUST be grandfathered via a one-time DATA backfill when
 * migration 0013 is applied to prod:
 *
 *     UPDATE organizations SET plan = 'pro' WHERE plan IS NULL;
 *
 * This is a data fix, NOT a code change: the free-tier default and the seat gate
 * (getOrgEntitlements + the maxStaff check in createInvite) are correct as-is and
 * must NOT be loosened to "fix" the legacy-org case.
 */
export const DEFAULT_PLAN: Plan = {
  id: "free",
  label: "Free",
  priceCents: 0,
  interval: "month",
  entitlements: {
    maxStaff: 2,
    maxConversationsPerMonth: 100,
    features: ["chat", "scheduling"],
  },
};

/** The paid tiers, ordered cheapest → most expensive (drives the upgrade UI). */
export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    label: "Starter",
    priceCents: 4900,
    interval: "month",
    entitlements: {
      maxStaff: 5,
      maxConversationsPerMonth: 1_000,
      features: ["chat", "scheduling", "integrations"],
    },
  },
  {
    id: "pro",
    label: "Pro",
    priceCents: 14900,
    interval: "month",
    entitlements: {
      maxStaff: 20,
      maxConversationsPerMonth: 10_000,
      features: ["chat", "scheduling", "integrations", "voice", "reporting"],
    },
  },
  {
    id: "scale",
    label: "Scale",
    priceCents: 39900,
    interval: "month",
    entitlements: {
      maxStaff: 100,
      // No conversation cap on Scale.
      features: [
        "chat",
        "scheduling",
        "integrations",
        "voice",
        "reporting",
        "priority_support",
      ],
    },
  },
];

/** Every selectable tier (default + paid), in display order. */
export const ALL_PLANS: readonly Plan[] = [DEFAULT_PLAN, ...PLANS];

/**
 * Resolve a plan by id. A NULL/blank/unknown id falls back to DEFAULT_PLAN so a
 * legacy org (NULL plan) or a stale id never crashes a caller — the floor is
 * always the free tier, never "unlimited".
 */
export function getPlan(planId: string | null | undefined): Plan {
  if (!planId) return DEFAULT_PLAN;
  return ALL_PLANS.find((p) => p.id === planId) ?? DEFAULT_PLAN;
}

/** True when `planId` names a real, selectable plan (used to validate input). */
export function isValidPlanId(planId: string): boolean {
  return ALL_PLANS.some((p) => p.id === planId);
}
