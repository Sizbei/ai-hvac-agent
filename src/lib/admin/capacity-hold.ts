/**
 * Capacity-hold decision layer — the PURE confirm-time slot logic (Stage 3).
 *
 * When a customer confirms a booking we must turn their soft preference
 * (morning/afternoon/evening/asap) into a CONCRETE bookable day+band and claim a
 * unit of that band's capacity — without two concurrent confirms both taking the
 * last open slot. This module is the pure DECISION half of that: given the
 * already-fetched open availability (counts per day+band, from
 * computeOpenWindows / getOpenAvailability), it picks a bookable slot, reports
 * how much capacity a band has, and exposes the tiny predicate the caller guards
 * its write with. It performs NO I/O — no DB, no fetch, no Date.now() — so it is
 * deterministically unit-testable and safe to import anywhere.
 *
 * ┌─ WHY PURE: the caller composes the CAS write ─────────────────────────────┐
 * │ This app runs on neon-http, which has NO interactive transactions —        │
 * │ db.transaction() THROWS at runtime, and there is no SELECT ... FOR UPDATE. │
 * │ The only atomic primitive is db.batch([...]). So a capacity hold CANNOT be │
 * │ a lock-read-then-write; it must be OPTIMISTIC concurrency (compare-and-swap │
 * │ / conditional write). The confirm route composes the hold as:              │
 * │                                                                            │
 * │   1. Re-READ open availability for the relevant days (fresh counts).       │
 * │   2. pickBookableSlot(...) → the concrete {day, window} to claim, or null. │
 * │   3. arrivalWindowForSlot(day, window) → the UTC instants to persist.      │
 * │   4. CONDITIONALLY write the arrival window ONLY IF the band is still open  │
 * │      (a guarded UPDATE / insert whose WHERE re-asserts available > 0, the   │
 * │      canHoldSlot predicate, against the same source the count came from).   │
 * │   5. If 0 rows changed, another confirm won the race — re-read and retry,   │
 * │      or report the band as full.                                            │
 * │                                                                            │
 * │ Keeping (2)–(3) pure here means the race-safe WRITE in (4) is the caller's  │
 * │ to compose with db.batch — this layer only DECIDES, it never reserves.     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import type { OpenAvailability } from "./types";
import { type ArrivalWindow, arrivalWindowHours } from "./arrival-window";
import { RESCHEDULE_WINDOW_ROWS } from "./calendar-time";
import { businessWallClockToUtc } from "./calendar-time";

/**
 * The customer's soft preference of WHEN they want service. The three concrete
 * bands map to a single arrival window; "asap" means "earliest open band on the
 * earliest open day", so the picker tries each band morning-first.
 */
export type PreferredWindow = "morning" | "afternoon" | "evening" | "asap";

/**
 * The `available` count for a single day+band, or 0 when that band isn't present
 * in the availability (band closed/not offered, or the day isn't covered).
 * Trivial lookup — but named so the CAS predicate (canHoldSlot) has one clear
 * source for "how many units are open right now".
 */
export function availableForBand(
  availability: OpenAvailability,
  day: string,
  window: string,
): number {
  const match = availability.windows.find(
    (w) => w.day === day && w.window === window,
  );
  return match ? match.available : 0;
}

/**
 * The reservation CEILING for a day+band: capacity − placed (assigned) bookings,
 * from the same availability snapshot. This is the number of concurrent holds a
 * band can carry so that placed + reserved stays within capacity FOR THAT
 * SNAPSHOT. Reserving within [0, ceiling) — rather than [0, capacity) — stops a
 * reservation from over-committing a band whose capacity is partly consumed by
 * already-assigned jobs. 0 when the band isn't present in the availability.
 *
 * CAVEAT (inherent to transaction-less neon-http): the ceiling is computed from a
 * snapshot, and the reservation UNIQUE index serializes reservations against each
 * OTHER but not against assignments. If a job is ASSIGNED concurrently with a
 * customer confirm (between that confirm's snapshot and its reserve insert), the
 * two use different ceilings and placed + reserved can briefly exceed capacity —
 * a narrow over-promise, reconciled downstream by the assign-time conflict gate /
 * exception queue. This is strictly better than the pre-reservation behavior
 * (which over-promised on every concurrent confirm); a hard guarantee would need
 * a shared CAS across the reservations and jobs tables.
 */
export function reserveCeilingForBand(
  availability: OpenAvailability,
  day: string,
  window: string,
): number {
  const match = availability.windows.find(
    (w) => w.day === day && w.window === window,
  );
  return match ? Math.max(0, match.capacity - (match.booked ?? 0)) : 0;
}

/**
 * Turn a soft preference into a CONCRETE bookable {day, window}, or null when
 * nothing is open. Scans `availability.days` in order (it is ascending) and
 * returns the EARLIEST day whose target band still has available > 0:
 *
 *  - A concrete band ("morning"/"afternoon"/"evening") → earliest day that band
 *    is open.
 *  - "asap" → earliest day that has ANY band open, trying bands morning-first
 *    (RESCHEDULE_WINDOW_ROWS order) so the soonest-in-the-day band wins ties.
 *
 * This is what confirm-time uses to resolve the customer's preference into the
 * slot it will attempt to claim; the caller still guards the write with
 * canHoldSlot against a fresh re-read (the count here may be stale by write
 * time — that's the whole point of the optimistic CAS).
 */
export function pickBookableSlot(
  availability: OpenAvailability,
  preferredWindow: string,
): { readonly day: string; readonly window: string } | null {
  // "asap" tries every band per day, soonest band first; a concrete preference
  // tries only that one band. Either way we walk days in ascending order and
  // take the first (day, band) with capacity left.
  const bandsToTry: readonly string[] =
    preferredWindow === "asap"
      ? RESCHEDULE_WINDOW_ROWS
      : [preferredWindow];

  for (const day of availability.days) {
    for (const window of bandsToTry) {
      if (availableForBand(availability, day, window) > 0) {
        return { day, window };
      }
    }
  }
  return null;
}

/**
 * The concrete UTC arrival-window instants for a day+band, with the band hours
 * read as BUSINESS-timezone (Eastern) wall clock — e.g. "morning" on a day →
 * 8:00 AM and 12:00 PM Eastern, converted to UTC (DST-correct via
 * businessWallClockToUtc). Shares arrivalWindowHours with the rest of the
 * calendar so the bounds can never drift. This is the start/end the caller
 * persists onto the request when the hold succeeds.
 *
 * "Pure" in that it does no I/O; it does use the timezone helpers, which are
 * themselves pure (no Date.now(), no env).
 */
export function arrivalWindowForSlot(
  day: string,
  window: string,
): { readonly startUtc: Date; readonly endUtc: Date } {
  const [startHour, endHour] = arrivalWindowHours(window as ArrivalWindow);
  return {
    startUtc: businessWallClockToUtc(day, startHour, 0),
    endUtc: businessWallClockToUtc(day, endHour, 0),
  };
}

/**
 * The compare-and-swap predicate: a hold may proceed iff there is at least one
 * unit of capacity left. Tiny, but it is the contract the caller's conditional
 * write re-asserts (WHERE available > 0) so two concurrent confirms can't both
 * take the last slot. Naming + testing it documents that contract in one place.
 */
export function canHoldSlot(availableCount: number): boolean {
  return availableCount > 0;
}
