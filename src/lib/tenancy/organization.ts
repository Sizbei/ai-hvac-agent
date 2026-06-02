import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Multi-tenancy: resolving which organization a customer chat belongs to.
 *
 * Today the public chat runs as a single seeded demo org. As the embeddable
 * widget lands, the organization will be resolved from the widget's publishable
 * key (and/or the request Origin) at SESSION CREATION time, and then persisted
 * on the customer session row. Every downstream route (chat, confirm, feedback,
 * escalate) must read the org from `session.organizationId` — NOT re-resolve or
 * hardcode it — so a session can never be mis-attributed to another tenant.
 *
 * This module is the single source of truth for that resolution. Keeping the
 * demo-org fallback here (rather than a constant copied into five routes) means
 * the widget-key path can be slotted in one place.
 */

/** The seeded demo organization. Used as the fallback when no tenant signal is
 * present (e.g. the hosted /chat demo page). Mirrors the id seeded in
 * src/lib/db/seed.ts. */
export const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

export interface OrganizationResolution {
  readonly organizationId: string;
  /** How the org was resolved — useful for logging/metrics and to distinguish
   * the demo fallback from a real widget-key match once that exists. */
  readonly source: "demo_fallback" | "widget_key" | "origin";
}

export interface ResolveOrganizationInput {
  /** Publishable widget key from the embed snippet (e.g. "pk_live_..."). */
  readonly publishableKey?: string | null;
  /** Request Origin header, for domain-allowlist resolution. */
  readonly origin?: string | null;
}

/**
 * Resolve the organization for a NEW customer session.
 *
 * Resolution order (as capabilities land):
 *   1. publishableKey  -> the org that owns the widget key (widget embed)
 *   2. origin          -> the org whose allowlist contains this domain
 *   3. demo fallback    -> the seeded demo org (hosted /chat demo)
 *
 * Steps 1–2 are not wired yet (no widget_keys table); this returns the demo
 * org. The signature is stable so the widget phase only fills in the lookups.
 */
export async function resolveOrganizationForSession(
  _input: ResolveOrganizationInput = {},
): Promise<OrganizationResolution> {
  // TODO(widget-phase): resolve by publishableKey, then by origin allowlist.
  return { organizationId: DEMO_ORG_ID, source: "demo_fallback" };
}

/** True if the organization exists. Cheap guard for resolution paths that
 * accept external input (a widget key mapping to a stale/deleted org). */
export async function organizationExists(
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!row) {
    logger.warn({ organizationId }, "Organization not found during resolution");
  }
  return Boolean(row);
}
