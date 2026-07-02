/**
 * TECHNICIAN SYNC: mirror Housecall Pro technicians into our users table.
 *
 * The HCP analog of fieldpulse/technician-sync. Same contract and safety
 * properties; degrade-safe (any HCP/network error is logged and swallowed).
 * Technicians are created with role="technician" and no password (they
 * authenticate via HCP, not our system), keyed on (organizationId, email).
 *
 * DIVERGENCE FROM FIELDPULSE: HCP's /employees has NO role field, so there is no
 * `isFieldpulseTechnician`-style filter — every employee is a technician
 * candidate. We still skip rows without an email or name. Identity is tracked in
 * the per-org-unique `housecallProUserId` column (HCP ids are opaque and repeat
 * across tenants), so the soft-deactivate can target HCP-sourced techs only.
 */
import { eq, and, isNotNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";

/** Normalize email for case-insensitive per-org matching (HCP may return mixed case). */
function normalizeEmail(email: string | null | undefined): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/**
 * Sync technicians from Housecall Pro into our users table. Best-effort:
 *  - No-ops when the org isn't HCP-connected.
 *  - Upserts each employee that has an email + name (creates/updates by org+email).
 *  - Sets isActive to match HCP's status; stores housecallProUserId for identity.
 *  - Soft-deactivates HCP-synced techs no longer in the roster — GUARDED so a
 *    transient empty roster never mass-deactivates the org's technicians.
 *  - Any error is logged and swallowed (degrade-safe).
 *
 * Returns the count of technicians upserted (for admin feedback).
 */
export async function syncTechniciansFromHousecall(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly synced: number }> {
  const client = await getHousecallClient(organizationId, fetchImpl);
  if (!client) {
    return { synced: 0 }; // org not connected
  }

  try {
    const technicians = await client.listTechnicians();

    let synced = 0;
    for (const tech of technicians) {
      const email = normalizeEmail(tech.email);
      const name = tech.name?.trim() ?? "";

      // Skip employees without the identifiers the upsert keys on.
      if (!email || !name) {
        logger.warn(
          { organizationId, housecallProUserId: tech.id },
          "Skipping HCP technician without valid email or name",
        );
        continue;
      }

      const [upserted] = await db
        .insert(users)
        .values({
          organizationId,
          email,
          name,
          role: "technician",
          isActive: tech.isActive !== false, // HCP active status (undefined → active)
          passwordHash: null, // techs authenticate via HCP, not us
          housecallProUserId: tech.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [users.organizationId, users.email],
          set: {
            name,
            isActive: tech.isActive !== false,
            housecallProUserId: tech.id,
            updatedAt: new Date(),
          },
          // Never clobber a human admin/super_admin sharing this email — only an
          // existing technician row may be overwritten.
          setWhere: eq(users.role, "technician"),
        })
        .returning({ id: users.id });

      if (upserted) {
        synced++;
      }
    }

    // Soft-deactivate HCP-synced techs no longer in the roster. GUARDED: if HCP
    // returned NO technicians we do nothing, rather than deactivating the whole
    // roster on a transient empty response.
    const currentHcpIds = technicians
      .map((t) => t.id)
      .filter((id): id is string => Boolean(id));
    if (currentHcpIds.length > 0) {
      await db
        .update(users)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.role, "technician"),
            isNotNull(users.housecallProUserId),
            notInArray(users.housecallProUserId, currentHcpIds),
          ),
        );
    }

    logger.info({ organizationId, synced }, "Synced technicians from Housecall Pro");
    return { synced };
  } catch (error: unknown) {
    logger.warn(
      { organizationId, error },
      "Housecall Pro technician sync failed (degraded)",
    );
    return { synced: 0 };
  }
}
