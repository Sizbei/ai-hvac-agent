/**
 * TECHNICIAN SYNC: mirror Fieldpulse technicians into our users table.
 *
 * Called from admin "Sync Technicians" button (background task). Degrade-safe:
 * any Fieldpulse/network error is logged and swallowed. Technicians are created
 * with role="technician" and no password (they authenticate via Fieldpulse, not
 * our system).
 *
 * IDEMPOTENT: uses upsert pattern (INSERT ... ON CONFLICT) to handle race
 * conditions gracefully. Email is scoped to organization, so the same email
 * can exist in different orgs (correct multi-tenant behavior).
 *
 * Stores fieldpulseUserId to track identity across email changes.
 */
import { eq, and, isNotNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";
import type { FieldpulseUser } from "./types";

/**
 * Map a Fieldpulse user to a users row. Filter to technicians only
 * (Fieldpulse may return other user types).
 */
function isFieldpulseTechnician(user: FieldpulseUser): boolean {
  // Fieldpulse technicians have role="technician" or similar
  // Adjust based on actual API response
  return user.role === "technician" || user.role === "Technician";
}

/**
 * Normalize email to lowercase for case-insensitive matching.
 * Fieldpulse may return "John@Doe.com" while we store "john@doe.com".
 */
function normalizeEmail(email: string | null | undefined): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/**
 * Sync technicians from Fieldpulse to our users table. Best-effort:
 *
 *  - No-ops when org isn't Fieldpulse-connected
 *  - Fetches all technicians from Fieldpulse
 *  - Upserts each technician (creates if not exists, updates if present)
 *  - Sets isActive to match Fieldpulse status
 *  - Stores fieldpulseUserId for identity tracking
 *  - Any error is logged and swallowed (degrade-safe)
 *
 * Returns count of technicians synced (for admin feedback).
 */
export async function syncTechniciansFromFieldpulse(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly synced: number }> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return { synced: 0 }; // org not connected
  }

  try {
    const fpUsers = await client.listUsers();
    const technicians = fpUsers.filter(isFieldpulseTechnician);

    let synced = 0;
    for (const tech of technicians) {
      const email = normalizeEmail(tech.email);
      const name = tech.name?.trim() ?? "";

      // Skip technicians without valid identifiers
      if (!email || !name) {
        logger.warn(
          { organizationId, fieldpulseUserId: tech.id },
          "Skipping technician without valid email or name",
        );
        continue;
      }

      // Upsert pattern: insert if not exists (by org+email), update if present
      // This handles race conditions gracefully - the unique constraint does
      // the deduplication, ON CONFLICT UPDATE applies changes.
      const [upserted] = await db
        .insert(users)
        .values({
          organizationId,
          email,
          name,
          role: "technician",
          isActive: tech.isActive !== false, // sync active status
          // No password - technicians authenticate via Fieldpulse, not us
          passwordHash: null,
          // Track Fieldpulse identity in its own per-org-unique column (NOT
          // google_id, whose unique index is global and collides across tenants).
          fieldpulseUserId: tech.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [users.organizationId, users.email],
          set: {
            name,
            isActive: tech.isActive !== false,
            fieldpulseUserId: tech.id, // Update if changed
            updatedAt: new Date(),
          },
          // Guard: never clobber a human admin/super_admin who happens to share
          // this email — only an existing technician row may be overwritten.
          setWhere: eq(users.role, "technician"),
        })
        .returning({ id: users.id });

      if (upserted) {
        synced++;
      }
    }

    // Soft-deactivate technicians that are no longer in Fieldpulse: synced techs
    // (matched by fieldpulse_user_id) whose id is NOT in the current FP
    // roster. Guarded — if Fieldpulse returned NO technicians we do nothing,
    // rather than deactivating the entire roster on a transient empty response.
    const currentFpIds = technicians
      .map((t) => t.id)
      .filter((id): id is string => Boolean(id));
    if (currentFpIds.length > 0) {
      await db
        .update(users)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.role, "technician"),
            // Only synced technicians…
            isNotNull(users.fieldpulseUserId),
            // …that are no longer present in Fieldpulse.
            notInArray(users.fieldpulseUserId, currentFpIds),
          ),
        );
    }

    logger.info(
      { organizationId, synced },
      "Synced technicians from Fieldpulse",
    );

    return { synced };
  } catch (error: unknown) {
    logger.warn(
      { organizationId, error },
      "Fieldpulse technician sync failed (degraded)",
    );
    return { synced: 0 };
  }
}
