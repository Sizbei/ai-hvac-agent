/**
 * Map Fieldpulse availability to our recurring slot format.
 *
 * Mirrors housecall-pro/availability-mapping.ts: convert Fieldpulse's bookable
 * windows into the shape our open-window math consumes. NOTE: Fieldpulse may not
 * expose an availability endpoint; this is a best-effort implementation based on
 * typical FSM patterns, and may need adjustment when/if the endpoint is confirmed.
 */

import type {
  AvailabilitySlot,
  MappedAvailability,
} from "@/lib/admin/scheduling-source";
import type { FieldpulseAvailabilitySlot } from "./types";

/** How far ahead we assume Fieldpulse reports bookable windows. */
export const FIELDPULSE_AVAILABILITY_HORIZON_DAYS = 14;

/**
 * Map a single Fieldpulse availability slot to our {@link AvailabilitySlot}.
 * Returns null when malformed.
 */
function mapSlot(raw: FieldpulseAvailabilitySlot): AvailabilitySlot | null {
  if (!raw.startIso || !raw.endIso) {
    return null;
  }
  // Derive a synthetic technician id from the user id (if present).
  const technicianId = raw.userId ? `fp_${raw.userId}` : "fp_any";
  return {
    technicianId,
    startIso: raw.startIso,
    endIso: raw.endIso,
  };
}

/**
 * The mapped availability surface: all bookable windows + the set of synthetic
 * technician ids they reference.
 */
export interface MappedFieldpulseAvailability extends MappedAvailability {
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
