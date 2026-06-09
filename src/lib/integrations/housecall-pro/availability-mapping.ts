/**
 * PURE Housecall Pro availability → SchedulingSource mapping.
 *
 * The app's open-window model (admin/availability.ts) is built on two facts per
 * technician: recurring weekly working hours ({@link AvailabilitySlot}) and the
 * jobs already booked into them ({@link ScheduledJob}). It then subtracts booked
 * time from working hours to compute how many slots are still open per band.
 *
 * Housecall Pro exposes a DIFFERENT shape: a flat list of concrete, already-net
 * bookable windows ({@link HousecallAvailabilitySlot}) — HCP has done the
 * subtraction for us, so each window it returns is genuinely open. To plug HCP in
 * behind the SchedulingSource seam WITHOUT distorting the open-window math, we:
 *
 *   1. Map each concrete HCP window to ONE synthetic "technician" whose single
 *      recurring availability slot is exactly that window's business-tz weekday +
 *      [startMinute, endMinute). Capacity for a band is then the number of HCP
 *      windows covering it — which is what the customer should see.
 *   2. Report NO booked jobs (the HCP windows are already net of bookings, so
 *      subtracting again would double-count and under-report availability).
 *
 * The synthetic technician ids are OPAQUE and contain NO HCP staff identity —
 * they are deterministic placeholders (`hcp-slot-<n>`), so the PII-free guarantee
 * of the public availability surface holds: the worst leak is still a count.
 *
 * This module is PURE (no I/O, no Date.now): given already-fetched HCP windows it
 * returns the synthetic slots + tech ids, so it unit-tests deterministically.
 */
import type { AvailabilitySlot } from "@/lib/admin/types";
import {
  businessMinutesOfDay,
  toBusinessWallClock,
} from "@/lib/admin/calendar-time";
import type { HousecallAvailabilitySlot } from "./types";

/** A stable prefix for synthetic HCP availability "technician" ids. Opaque: it
 * never contains an HCP staff name/id, so the no-PII guarantee is preserved. */
export const HCP_SYNTHETIC_TECH_PREFIX = "hcp-slot-";

/** The synthetic availability surface derived from HCP's bookable windows: the
 * recurring slots to feed computeOpenWindows + the opaque tech ids they belong
 * to (the roster the seam reports as "active technicians" when HCP is source). */
export interface MappedHcpAvailability {
  readonly slots: readonly AvailabilitySlot[];
  readonly technicianIds: readonly string[];
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * The business-tz weekday (0=Sun … 6=Sat) an instant falls on. Derived from the
 * Eastern wall-clock date (DST-correct), NOT the UTC day — a late-evening UTC
 * instant can be the previous Eastern day, and the open-window math keys on the
 * Eastern weekday.
 */
function businessWeekdayOfInstant(instant: Date): number {
  const wall = toBusinessWallClock(instant);
  // Build a UTC date from the Eastern wall-clock Y/M/D so getUTCDay reads the
  // Eastern calendar weekday without re-applying an offset.
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/**
 * Map one concrete HCP window to a recurring {@link AvailabilitySlot} for a
 * synthetic technician, or null when the window is malformed or doesn't describe
 * a positive same-business-day span.
 *
 * The window's start/end are read in the BUSINESS timezone (Eastern), matching
 * how computeOpenWindows interprets a slot's [startMinute, endMinute). A window
 * whose end rolls into the next Eastern day is clamped to end-of-day so it still
 * contributes its same-day portion (the open-window bands live within one day).
 */
function windowToSlot(
  window: HousecallAvailabilitySlot,
  index: number,
): AvailabilitySlot | null {
  const start = new Date(window.startIso);
  const end = new Date(window.endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  // A non-positive instant span (end at or before start) is malformed — drop it
  // before the minute math so a zero-length window can't be promoted to a
  // bogus full day by the midnight-cross clamp below.
  if (end.getTime() <= start.getTime()) {
    return null;
  }

  const dayOfWeek = businessWeekdayOfInstant(start);
  const startMinute = businessMinutesOfDay(start);
  // End may read earlier than start when the window crosses Eastern midnight;
  // clamp to end-of-day so a same-day window still maps to a positive span. The
  // instant span is already known positive (guarded above), so this only handles
  // the calendar-day roll, never a zero-span window.
  const rawEndMinute = businessMinutesOfDay(end);
  const endMinute = rawEndMinute <= startMinute ? MINUTES_PER_DAY : rawEndMinute;

  const technicianId = `${HCP_SYNTHETIC_TECH_PREFIX}${index}`;
  return {
    id: `hcp-avail-${index}`,
    technicianId,
    dayOfWeek,
    startMinute,
    endMinute,
  };
}

/**
 * Map a list of HCP bookable windows to the synthetic availability surface.
 * Each VALID window becomes its own synthetic technician (so capacity for a band
 * counts the HCP windows covering it). Malformed windows are dropped rather than
 * throwing — a single bad row from HCP must not blank the whole day.
 */
export function mapHcpAvailability(
  windows: readonly HousecallAvailabilitySlot[],
): MappedHcpAvailability {
  const slots: AvailabilitySlot[] = [];
  const technicianIds: string[] = [];
  windows.forEach((window, index) => {
    const slot = windowToSlot(window, index);
    if (slot) {
      slots.push(slot);
      technicianIds.push(slot.technicianId);
    }
  });
  return { slots, technicianIds };
}
