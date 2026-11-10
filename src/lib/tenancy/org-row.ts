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
