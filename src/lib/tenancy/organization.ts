import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, organizationSettings } from "@/lib/db/schema";
import { validateKey } from "@/lib/widget/key-queries";
import { isOriginAllowed } from "@/lib/widget/origin";
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

export type OrganizationResolution =
  | {
      readonly ok: true;
      readonly organizationId: string;
      /** How the org was resolved — for logging/metrics. */
      readonly source: "demo_fallback" | "widget_key";
      /** The widget key id that resolved this org (for last-used tracking);
       * absent for the demo fallback. */
      readonly widgetKeyId?: string;
    }
  | {
      readonly ok: false;
      /** invalid_key: key unknown/revoked/wrong type. origin_not_allowed: key
       * valid but the request Origin isn't on the org's allowlist. */
      readonly reason: "invalid_key" | "origin_not_allowed";
    };

export interface ResolveOrganizationInput {
  /** Publishable widget key from the embed snippet (e.g. "pk_live_..."). */
  readonly publishableKey?: string | null;
  /** Request Origin header, for domain-allowlist resolution. */
  readonly origin?: string | null;
}

/**
 * Resolve the organization for a NEW customer session.
 *
 *   1. No publishable key  -> the seeded demo org (hosted /chat demo page).
 *   2. Publishable key      -> the org that owns it. If that org has configured
 *      an origin allowlist, the request Origin MUST match it (else reject); an
 *      empty allowlist means "not locked down yet" and the key alone suffices.
 *
 * A SECRET key is never accepted here — only publishable keys start sessions.
 */
export async function resolveOrganizationForSession(
  input: ResolveOrganizationInput = {},
): Promise<OrganizationResolution> {
  const publishableKey = input.publishableKey?.trim();

  // No key → the hosted demo page. Keep the existing single-tenant behavior.
  if (!publishableKey) {
    return { ok: true, organizationId: DEMO_ORG_ID, source: "demo_fallback" };
  }

  const validated = await validateKey(publishableKey);
  // Must be a known, active PUBLISHABLE key (secret keys can't open sessions).
  if (!validated || validated.keyType !== "publishable") {
    return { ok: false, reason: "invalid_key" };
  }

  // Enforce the org's origin allowlist when one is configured.
  const [settings] = await db
    .select({ allowedOrigins: organizationSettings.allowedOrigins })
    .from(organizationSettings)
    .where(
      eq(organizationSettings.organizationId, validated.organizationId),
    )
    .limit(1);

  const allowed = settings?.allowedOrigins ?? [];
  if (allowed.length > 0 && !isOriginAllowed(input.origin, allowed)) {
    return { ok: false, reason: "origin_not_allowed" };
  }

  return {
    ok: true,
    organizationId: validated.organizationId,
    source: "widget_key",
    widgetKeyId: validated.id,
  };
}

/**
 * The org a publishable widget key belongs to, WITHOUT the origin allowlist —
 * for the session-RESUME cross-org guard only. A same-origin resume GET carries
 * no Origin header, so running it through resolveOrganizationForSession's origin
 * check would fail (origin_not_allowed) for any org with an allowlist and make
 * the resume guard dead code. Origin enforcement is a session-CREATION + CSP
 * concern; resume only needs "does this key map to my session's org?". Returns
 * null for a missing/invalid/non-publishable key (caller must fail closed).
 */
export async function organizationIdForPublishableKey(
  publishableKey: string | null | undefined,
): Promise<string | null> {
  const key = publishableKey?.trim();
  if (!key) return null;
  const validated = await validateKey(key);
  if (!validated || validated.keyType !== "publishable") return null;
  return validated.organizationId;
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
