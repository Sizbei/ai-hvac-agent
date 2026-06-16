/**
 * AVAILABILITY SYNC: mirror Fieldpulse technician availability to our calendar.
 *
 * Syncs technician working hours from Fieldpulse into our technician_availability
 * table so open-slot math can use Fieldpulse as the source of truth.
 *
 * DEGRADE-SAFE: any Fieldpulse/network error is logged and swallowed; the system
 * falls back to locally-stored availability. The status write in the failure path
 * is ITSELF wrapped so a DB hiccup there can never leave the org stuck
 * "in_progress".
 *
 * CONCURRENCY: a single atomic compare-and-set claims the sync ("in_progress")
 * — two racing invocations cannot both proceed (the loser gets zero rows).
 *
 * IDEMPOTENT: delete-then-insert per affected technician, so a re-run converges
 * to the same rows rather than accumulating duplicates.
 */
import { eq, and, ne, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  fieldpulseConnections,
  technicianAvailability,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";
import {
  mapFieldpulseAvailability,
  FIELDPULSE_AVAILABILITY_HORIZON_DAYS,
} from "./availability-mapping";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sync status values - match the DB enum. */
export type AvailabilitySyncStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

/** Result of a sync operation. */
export interface AvailabilitySyncResult {
  readonly success: boolean;
  readonly synced: number; // Number of slots upserted
  readonly error?: string; // Error message if failed
}

/**
 * Atomically claim the sync for an org via compare-and-set. Returns true only if
 * THIS call transitioned the connected org out of "in_progress" — so two racing
 * syncs cannot both proceed (neon-http has no transactions, but a single
 * conditional UPDATE is atomic). Returns false when the org isn't connected or a
 * sync is already running.
 */
async function claimSync(organizationId: string): Promise<boolean> {
  const claimed = await db
    .update(fieldpulseConnections)
    .set({ availabilitySyncStatus: "in_progress", updatedAt: new Date() })
    .where(
      withTenant(
        fieldpulseConnections,
        organizationId,
        eq(fieldpulseConnections.connected, true),
        ne(fieldpulseConnections.availabilitySyncStatus, "in_progress"),
      ),
    )
    .returning({ id: fieldpulseConnections.id });
  return claimed.length > 0;
}

/**
 * Mark the sync completed (clears any prior error). Best-effort.
 */
async function markCompleted(organizationId: string): Promise<void> {
  await db
    .update(fieldpulseConnections)
    .set({
      availabilitySyncStatus: "completed",
      lastAvailabilitySyncAt: new Date(),
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(withTenant(fieldpulseConnections, organizationId));
}

/**
 * Mark the sync failed with an error message. Wrapped so a DB error here can
 * never escape the caller's catch and leave the org stuck "in_progress".
 */
async function safeMarkFailed(
  organizationId: string,
  error: string,
): Promise<void> {
  try {
    await db
      .update(fieldpulseConnections)
      .set({
        availabilitySyncStatus: "failed",
        lastSyncError: error,
        updatedAt: new Date(),
      })
      .where(withTenant(fieldpulseConnections, organizationId));
  } catch (markError: unknown) {
    logger.error(
      { organizationId, markError },
      "Failed to record availability sync failure status",
    );
  }
}

/**
 * Resolve the synthetic Fieldpulse technician ids ("fp_<userId>") to our internal
 * users.id in a SINGLE batched query. "fp_any" (no specific tech) has no mapping
 * and is dropped. Only active technicians in the org are matched.
 */
async function resolveTechnicianIds(
  organizationId: string,
  syntheticIds: readonly string[],
): Promise<Map<string, string>> {
  const fieldpulseUserIds = syntheticIds
    .filter((id) => id.startsWith("fp_") && id !== "fp_any")
    .map((id) => id.slice("fp_".length));

  const map = new Map<string, string>();
  if (fieldpulseUserIds.length === 0) {
    return map;
  }

  const rows = await db
    .select({ id: users.id, fieldpulseUserId: users.fieldpulseUserId })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        eq(users.role, "technician"),
        eq(users.isActive, true),
        inArray(users.fieldpulseUserId, fieldpulseUserIds),
      ),
    );

  for (const row of rows) {
    if (row.fieldpulseUserId) {
      map.set(`fp_${row.fieldpulseUserId}`, row.id);
    }
  }
  return map;
}

/** A validated availability row ready to insert. */
interface AvailabilityRow {
  readonly organizationId: string;
  readonly technicianId: string;
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Sync technician availability from Fieldpulse. Best-effort + degrade-safe:
 *
 *  - No-ops (returns success:false) when org isn't connected.
 *  - Claims the sync atomically; a concurrent sync returns "Sync already in
 *    progress".
 *  - Maps Fieldpulse's real bookable windows (NOT placeholders) to recurring
 *    weekly slots, resolves technicians in one batched query, then
 *    delete-then-inserts the affected technicians' slots.
 *  - Any error transitions the org to "failed" (swallowed) and returns the
 *    message — never throws.
 */
export async function syncAvailabilityFromFieldpulse(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailabilitySyncResult> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return { success: false, synced: 0, error: "Fieldpulse not connected" };
  }

  // `claimed` lives outside the try so the catch knows whether WE took the
  // "in_progress" lock. claimSync is INSIDE the try: if it writes the lock and
  // then throws (e.g. a Neon transport error parsing the RETURNING), the catch
  // still runs safeMarkFailed so the org can never get stuck "in_progress".
  let claimed = false;
  try {
    // Atomic claim — prevents two concurrent syncs from racing.
    claimed = await claimSync(organizationId);
    if (!claimed) {
      return { success: false, synced: 0, error: "Sync already in progress" };
    }

    const startMs = Date.now();
    const range = {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(
        startMs + FIELDPULSE_AVAILABILITY_HORIZON_DAYS * MS_PER_DAY,
      ).toISOString(),
    };

    const fpAvailability = await client.listAvailability(range);

    // Map Fieldpulse's ACTUAL windows to recurring weekly slots (day-of-week +
    // minutes), dropping malformed ones — no placeholder times.
    const mapped = mapFieldpulseAvailability(fpAvailability);

    // Resolve every referenced synthetic technician id in one query.
    const technicianIdMap = await resolveTechnicianIds(
      organizationId,
      mapped.technicanIds,
    );

    const now = new Date();
    const rows: AvailabilityRow[] = [];
    for (const slot of mapped.slots) {
      const technicianId = technicianIdMap.get(slot.technicianId);
      if (!technicianId) {
        // Unknown / unsynced Fieldpulse technician (or "fp_any") — skip.
        continue;
      }
      // mapFieldpulseAvailability already validated start<end and ranges, but
      // re-guard defensively before writing.
      if (
        slot.dayOfWeek < 0 ||
        slot.dayOfWeek > 6 ||
        slot.startMinute < 0 ||
        slot.startMinute > 1440 ||
        slot.endMinute < 0 ||
        slot.endMinute > 1440 ||
        slot.startMinute >= slot.endMinute
      ) {
        continue;
      }
      rows.push({
        organizationId,
        technicianId,
        dayOfWeek: slot.dayOfWeek,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        createdAt: now,
        updatedAt: now,
      });
    }

    const affectedTechnicianIds = Array.from(
      new Set(rows.map((r) => r.technicianId)),
    );

    // Delete-then-insert for the affected technicians, ATOMICALLY: neon-http has
    // no interactive transactions, but db.batch executes its statements as one
    // unit — so there's no window where a technician's old slots are deleted but
    // the new ones aren't yet inserted. (affectedTechnicianIds is non-empty iff
    // rows is non-empty, so both statements always run together or not at all.)
    if (rows.length > 0) {
      await db.batch([
        db
          .delete(technicianAvailability)
          .where(
            withTenant(
              technicianAvailability,
              organizationId,
              inArray(technicianAvailability.technicianId, affectedTechnicianIds),
            ),
          ),
        db.insert(technicianAvailability).values(rows),
      ]);
    }

    await markCompleted(organizationId);

    logger.info(
      { organizationId, synced: rows.length },
      "Synced availability from Fieldpulse",
    );

    return { success: true, synced: rows.length };
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.warn(
      { organizationId, error },
      "Fieldpulse availability sync failed (degraded)",
    );

    // Only release the lock WE took. If claimSync itself threw, claimed may be
    // false yet the lock could have been written before the throw — marking
    // failed is still safe (a contending sync would have made claimSync return
    // false, not throw, so we never clobber another in-progress run).
    await safeMarkFailed(organizationId, errorMessage);

    return { success: false, synced: 0, error: errorMessage };
  }
}

/**
 * Get the current sync status for an organization. Used by the admin UI to
 * display sync state, last sync time, and last error.
 */
export async function getAvailabilitySyncStatus(
  organizationId: string,
): Promise<{
  readonly status: AvailabilitySyncStatus;
  readonly lastSyncAt: Date | null;
  readonly lastError: string | null;
}> {
  const [row] = await db
    .select({
      status: fieldpulseConnections.availabilitySyncStatus,
      lastSyncAt: fieldpulseConnections.lastAvailabilitySyncAt,
      lastError: fieldpulseConnections.lastSyncError,
    })
    .from(fieldpulseConnections)
    .where(
      and(
        withTenant(fieldpulseConnections, organizationId),
        eq(fieldpulseConnections.connected, true),
      ),
    );

  return {
    status: row?.status ?? "pending",
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
  };
}
