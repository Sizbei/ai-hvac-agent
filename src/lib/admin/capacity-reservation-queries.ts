/**
 * Capacity-reservation write/read layer — the DB half of the race-safe hold.
 *
 * The pure decision layer (capacity-hold.ts) picks WHICH (day, band) to claim;
 * this module performs the atomic CLAIM against the capacity_reservations table.
 * neon-http has no interactive transactions and no SELECT ... FOR UPDATE, so the
 * only atomicity primitive is the UNIQUE(org, day, window, slot_ordinal) index:
 * we INSERT at the lowest free ordinal in [0, ceiling), and a concurrent confirm
 * that grabbed that ordinal between our read and insert loses the CAS (0 rows
 * inserted) → we advance to the next ordinal. When every ordinal in [0, ceiling)
 * is taken the band is genuinely full → return null (the caller soft-books).
 *
 * CONTRACT: reserveCapacitySlot NEVER throws — any error resolves to null so the
 * confirm path always falls back to a soft booking and never blocks the lead.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { capacityReservations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import type { CapacityReservationSlot } from "./types";

/**
 * The ascending free ordinals in [0, ceiling) given the currently-taken set.
 * Pure — the ordinal-selection order the CAS loop walks. Full band → []. Kept
 * separate so the selection/full-band logic is unit-testable without a DB.
 */
export function freeOrdinals(
  taken: ReadonlySet<number>,
  ceiling: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < ceiling; i += 1) {
    if (!taken.has(i)) out.push(i);
  }
  return out;
}

/**
 * Atomically claim one unit of a (day, band)'s capacity for a request, or null
 * when the band is full / on any error.
 *
 * `ceiling` is capacity − already-placed bookings for the band (from the same
 * availability snapshot the slot was picked from), so at most `ceiling`
 * reservations can coexist and total consumption (placed + reserved) never
 * exceeds capacity. We read the taken ordinals once, then walk the free ones
 * lowest-first, inserting with onConflictDoNothing — an empty `returning` means
 * a concurrent confirm won that ordinal, so we advance.
 */
export async function reserveCapacitySlot(params: {
  readonly organizationId: string;
  readonly day: string;
  readonly window: string;
  readonly ceiling: number;
  readonly serviceRequestId: string;
}): Promise<{ readonly id: string; readonly ordinal: number } | null> {
  const { organizationId, day, window, ceiling, serviceRequestId } = params;
  if (ceiling <= 0) return null;
  try {
    const existing = await db
      .select({ slotOrdinal: capacityReservations.slotOrdinal })
      .from(capacityReservations)
      .where(
        withTenant(
          capacityReservations,
          organizationId,
          eq(capacityReservations.day, day),
          eq(capacityReservations.window, window),
        ),
      );
    const taken = new Set<number>(existing.map((r) => r.slotOrdinal));

    for (const ordinal of freeOrdinals(taken, ceiling)) {
      const inserted = await db
        .insert(capacityReservations)
        .values({ organizationId, day, window, slotOrdinal: ordinal, serviceRequestId })
        // The UNIQUE index is the CAS: a racing confirm that already took this
        // ordinal makes this a no-op (empty returning) → try the next ordinal.
        .onConflictDoNothing({
          target: [
            capacityReservations.organizationId,
            capacityReservations.day,
            capacityReservations.window,
            capacityReservations.slotOrdinal,
          ],
        })
        .returning({ id: capacityReservations.id });
      const row = inserted[0];
      if (row) return { id: row.id, ordinal };
      // Lost the race for this ordinal; mark it and keep walking.
      taken.add(ordinal);
    }
    // Every ordinal in [0, ceiling) is taken → band genuinely full.
    return null;
  } catch (error: unknown) {
    logger.error(
      { error, organizationId, day, window },
      "reserveCapacitySlot failed — treating band as full (soft booking)",
    );
    return null;
  }
}

/**
 * Active reservations across `days`, projected to the fields the open-window
 * math needs (PII-free). Tenant-scoped. Empty `days` → no query.
 */
export async function getActiveReservationsForDays(
  organizationId: string,
  days: readonly string[],
): Promise<readonly CapacityReservationSlot[]> {
  if (days.length === 0) return [];
  const rows = await db
    .select({
      day: capacityReservations.day,
      window: capacityReservations.window,
      serviceRequestId: capacityReservations.serviceRequestId,
    })
    .from(capacityReservations)
    .where(
      withTenant(
        capacityReservations,
        organizationId,
        inArray(capacityReservations.day, [...days]),
      ),
    );
  return rows;
}

/**
 * Release (delete) all holds for a request — the request was placed, cancelled,
 * or unscheduled, so its in-flight claim is no longer relevant. Best-effort:
 * failures are swallowed (a lingering hold is deduped out of availability by
 * request id, so a failed release under-utilizes at worst, never over-promises).
 */
export async function releaseReservationsForRequest(
  organizationId: string,
  serviceRequestId: string,
): Promise<void> {
  try {
    await db
      .delete(capacityReservations)
      .where(
        withTenant(
          capacityReservations,
          organizationId,
          eq(capacityReservations.serviceRequestId, serviceRequestId),
        ),
      );
  } catch (error: unknown) {
    logger.error(
      { error, organizationId, serviceRequestId },
      "releaseReservationsForRequest failed (non-fatal)",
    );
  }
}

/**
 * Release a single hold by id — used to clean up a just-created reservation when
 * the request insert it belonged to fails (so the orphaned hold doesn't squat a
 * slot forever). Best-effort.
 */
export async function releaseReservationById(
  organizationId: string,
  reservationId: string,
): Promise<void> {
  try {
    await db
      .delete(capacityReservations)
      .where(
        withTenant(
          capacityReservations,
          organizationId,
          eq(capacityReservations.id, reservationId),
        ),
      );
  } catch (error: unknown) {
    logger.error(
      { error, organizationId, reservationId },
      "releaseReservationById failed (non-fatal)",
    );
  }
}
