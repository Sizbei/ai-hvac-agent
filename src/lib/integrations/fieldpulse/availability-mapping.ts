/**
 * Map Fieldpulse availability to our recurring slot format.
 *
 * Mirrors housecall-pro/availability-mapping.ts: convert Fieldpulse's bookable
 * windows into the shape our open-window math consumes. NOTE: Fieldpulse may not
 * expose an availability endpoint; this is a best-effort implementation based on
 * typical FSM patterns, and may need adjustment when/if the endpoint is confirmed.
 */

import type { AvailabilitySlot } from "@/lib/admin/types";
import type { FieldpulseAvailabilitySlot } from "./types";

/** How far ahead we assume Fieldpulse reports bookable windows. */
export const FIELDPULSE_AVAILABILITY_HORIZON_DAYS = 14;

/**
 * Map a single Fieldpulse availability slot to our {@link AvailabilitySlot}.
 * Returns null when malformed.
 *
 * Fieldpulse reports absolute ISO windows, but our {@link AvailabilitySlot} is a
 * recurring weekly window (day-of-week + minutes-from-midnight) that the
 * open-window math expands. We derive the recurring shape from the window's UTC
 * components. ASSUMPTION: each Fieldpulse window starts and ends on the same UTC
 * day; multi-day windows are dropped (start must precede end within the day).
 */
function mapSlot(raw: FieldpulseAvailabilitySlot): AvailabilitySlot | null {
  if (!raw.startIso || !raw.endIso) {
    return null;
  }
  const start = new Date(raw.startIso);
  const end = new Date(raw.endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  const dayOfWeek = start.getUTCDay();
  const startMinute = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinute = end.getUTCHours() * 60 + end.getUTCMinutes();
  if (startMinute >= endMinute) {
    return null;
  }
  // Derive a synthetic technician id from the user id (if present).
  const technicianId = raw.userId ? `fp_${raw.userId}` : "fp_any";
  return {
    id: `${technicianId}:${dayOfWeek}:${startMinute}:${endMinute}`,
    technicianId,
    dayOfWeek,
    startMinute,
    endMinute,
  };
}

/**
 * The mapped availability surface: all bookable windows + the set of synthetic
 * technician ids they reference.
 */
export interface MappedFieldpulseAvailability {
  /** All valid slots derived from Fieldpulse's availability API. */
  readonly slots: readonly AvailabilitySlot[];
  /**
   * The set of synthetic technician ids inferred from the slots (opaque prefix +
   * Fieldpulse user id). Used by the scheduling source when the roster fetch fails.
   */
  readonly technicanIds: readonly string[];
}

/**
 * Map Fieldpulse's raw availability response to our consolidated surface.
 * Drops malformed slots rather than throwing.
 */
export function mapFieldpulseAvailability(
  rawSlots: readonly FieldpulseAvailabilitySlot[],
): MappedFieldpulseAvailability {
  const slots = rawSlots
    .map(mapSlot)
    .filter((s): s is AvailabilitySlot => s !== null);

  // Collect unique synthetic technician ids from the slots.
  const techIds = new Set<string>();
  for (const slot of slots) {
    techIds.add(slot.technicianId);
  }

  return {
    slots,
    technicanIds: Array.from(techIds),
  };
}

/**
 * Recurring weekly slot pattern for a technician.
 *
 * Fieldpulse may return availability as a recurring pattern (e.g., "Mon-Fri 8am-5pm")
 * rather than individual bookable windows. This type represents that pattern.
 */
export interface RecurringSlotPattern {
  readonly technicianId: string;
  readonly dayOfWeek: number; // 0=Sunday … 6=Saturday
  readonly startMinute: number; // Minutes from midnight
  readonly endMinute: number; // Minutes from midnight
}

/**
 * Fieldpulse recurring availability response (if available).
 *
 * If Fieldpulse exposes a weekly recurring schedule endpoint, this shape
 * represents the response. Otherwise, we infer recurring patterns from
 * the bookable windows returned by listAvailability.
 */
export interface FieldpulseRecurringAvailability {
  readonly userId?: string;
  readonly dayOfWeek: number;
  readonly startTime: string; // HH:MM format in business timezone
  readonly endTime: string; // HH:MM format in business timezone
}

/**
 * Parse HH:MM time string to minutes from midnight.
 * Returns null when malformed.
 */
function parseTimeToMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) {
    return null;
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * Map a Fieldpulse recurring availability slot to our pattern.
 * Returns null when malformed.
 */
function mapRecurringSlot(
  raw: FieldpulseRecurringAvailability,
): RecurringSlotPattern | null {
  const startMinute = parseTimeToMinutes(raw.startTime);
  const endMinute = parseTimeToMinutes(raw.endTime);

  if (
    startMinute === null ||
    endMinute === null ||
    raw.dayOfWeek < 0 ||
    raw.dayOfWeek > 6
  ) {
    return null;
  }

  // Validate: start must be before end, and duration should be reasonable
  if (startMinute >= endMinute) {
    return null;
  }

  // Max 24 hours (1440 minutes) per day
  if (endMinute - startMinute > 1440) {
    return null;
  }

  return {
    technicianId: raw.userId ? `fp_${raw.userId}` : "fp_any",
    dayOfWeek: raw.dayOfWeek,
    startMinute,
    endMinute,
  };
}

/**
 * Convert Fieldpulse recurring availability to our recurring slot format.
 *
 * This is used when Fieldpulse exposes a weekly schedule endpoint. The input
 * is an array of recurring patterns (one per technician per day). The output
 * is an array of validated patterns ready to upsert into technician_availability.
 *
 * Drops malformed patterns rather than throwing — a single bad row must not
 * block the entire sync.
 */
export function convertRecurringSlots(
  rawRecurring: readonly FieldpulseRecurringAvailability[],
): readonly RecurringSlotPattern[] {
  return rawRecurring
    .map(mapRecurringSlot)
    .filter((s): s is RecurringSlotPattern => s !== null);
}
