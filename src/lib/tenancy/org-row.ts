import * as React from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";

export interface OrgRow {
  readonly status: (typeof organizations.$inferSelect)["status"];
  readonly name: string;
  readonly featureFlags: unknown;
}

// React.cache only exists under the react-server condition; plain Node (vitest,
// scripts) gets an uncached passthrough.
const cache: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R =
  (React as { cache?: <F>(fn: F) => F }).cache ?? ((fn) => fn);

/** One org lookup per request (React cache); THROWS on a DB error. */
export const loadOrgRow = cache(async function loadOrgRow(
  organizationId: string,
): Promise<OrgRow | null> {
  const [row] = await db
    .select({
      status: organizations.status,
      name: organizations.name,
      featureFlags: organizations.featureFlags,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
});

/**
 * Final wave M2: every admin request reads the org row (viewer features, the
 * layout's billing/map/name), so display reads go through a 30 s
 * per-instance TTL cache keyed by org, like the session revocation cache.
 *
 * - Only a completed read is stored (a null row included); a failed read
 *   throws and is never cached.
 * - `invalidateOrgRow` (the platform switches PATCH) drops this instance's
 *   entry; a read already in flight when that happens is not stored.
 * - Other instances, and CLI writers such as set-history-cutoff.mjs, are not
 *   reached: they see the change within 30 s.
 * - Money and consent gates (getFeatures) keep calling loadOrgRow directly.
 */
export const ORG_ROW_TTL_MS = 30_000;
const orgRowCache = new Map<string, { readonly row: OrgRow | null; readonly at: number }>();
const orgRowGeneration = new Map<string, number>();

export async function loadOrgRowCached(organizationId: string): Promise<OrgRow | null> {
  const hit = orgRowCache.get(organizationId);
  if (hit && Date.now() - hit.at < ORG_ROW_TTL_MS) return hit.row;
  const generation = orgRowGeneration.get(organizationId) ?? 0;
  const row = await loadOrgRow(organizationId);
  if ((orgRowGeneration.get(organizationId) ?? 0) === generation) {
    orgRowCache.set(organizationId, { row, at: Date.now() });
  }
  return row;
}

/** Drop this instance's cached row for the org (after a feature switch write). */
export function invalidateOrgRow(organizationId: string): void {
  orgRowCache.delete(organizationId);
  orgRowGeneration.set(organizationId, (orgRowGeneration.get(organizationId) ?? 0) + 1);
}

/** Test hook: reset the cache so cases don't leak into each other. */
export function clearOrgRowCacheForTests(): void {
  orgRowCache.clear();
  orgRowGeneration.clear();
}
