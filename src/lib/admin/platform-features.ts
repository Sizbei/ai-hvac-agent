import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, platformAuditLog } from "@/lib/db/schema";
import { parseFeatures, type FeatureKey, type Features } from "@/lib/tenancy/feature-flags";
import { invalidateOrgRow } from "@/lib/tenancy/org-row";

/**
 * Merge `patch` into an org's feature switches and record who did it, in ONE
 * batch (neon-http has no transactions). The audit details carry key names and
 * booleans only. Returns the merged features, or null when the org is missing.
 * Drops this instance's cached org row so the change shows here at once
 * (other instances within the 30 s TTL).
 */
export async function updateOrgFeatures(
  orgId: string,
  patch: Partial<Record<FeatureKey, boolean>>,
  actor: { userId: string; email: string },
): Promise<Features | null> {
  const [updated] = await db.batch([
    db
      .update(organizations)
      .set({
        featureFlags: sql`${organizations.featureFlags} || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(organizations.id, orgId))
      .returning({ featureFlags: organizations.featureFlags }),
    db.insert(platformAuditLog).values({
      action: "org_features_update",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetOrgId: orgId,
      details: { features: patch },
    }),
  ]);
  invalidateOrgRow(orgId);
  const row = updated[0];
  return row ? parseFeatures(row.featureFlags) : null;
}
