import type { KnownSlots } from "./intent-router";
import type { ExtractionResult } from "./extraction-schema";

/**
 * Helpers for moving extracted slots between the session's `metadata` column
 * (stored as an `ExtractionResult` JSON string) and the router's `KnownSlots`
 * shape, with merge semantics that NEVER overwrite a filled slot with an empty
 * value (review finding H2).
 *
 * Beyond the 6 core slots (issue/urgency/address/name/phone/email) the intake
 * now also captures the ServiceTitan-style enrichment fields. Those are carried
 * through merge/parse/build as a generic bag so a filled value is preserved
 * across turns just like the core slots, without every caller having to name
 * each field.
 */

// The ServiceTitan-style enrichment fields (all optional on ExtractionResult).
// Kept as a list so merge/parse/build stay in sync as fields are added.
export const EXTRA_SLOT_KEYS = [
  "systemType",
  "equipmentBrand",
  "equipmentAgeBand",
  "propertyType",
  "ownerOccupant",
  "underWarranty",
  "accessNotes",
  "systemDownStatus",
  "problemDuration",
  "vulnerableOccupants",
  "preferredWindow",
  "contactPreference",
  "smsConsent",
  "leadSource",
] as const;

export type ExtraSlots = Partial<
  Pick<ExtractionResult, (typeof EXTRA_SLOT_KEYS)[number]>
>;

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Pull the extra (non-core) slots out of a parsed metadata object. */
function pickExtras(source: Partial<ExtractionResult>): ExtraSlots {
  const out: Record<string, unknown> = {};
  for (const key of EXTRA_SLOT_KEYS) {
    const v = (source as Record<string, unknown>)[key];
    if (isFilled(v)) out[key] = v;
  }
  return out as ExtraSlots;
}

/** Parse the session metadata JSON string into router KnownSlots (+ extras). */
export function parseKnownSlots(metadata: string | null): KnownSlots {
  if (!metadata) return {};
  try {
    const m = JSON.parse(metadata) as Partial<ExtractionResult>;
    return {
      issueType: m.issueType ?? null,
      urgency: m.urgency ?? null,
      address: m.address ?? null,
      name: m.customerName ?? null,
      phone: m.customerPhone ?? null,
      email: m.customerEmail ?? null,
      extras: pickExtras(m),
    };
  } catch {
    return {};
  }
}

/** Merge updates into known slots; a filled known value is never clobbered by an empty update. */
export function mergeSlots(
  known: KnownSlots,
  updates: Partial<KnownSlots>,
): KnownSlots {
  const pick = <T>(current: T | null | undefined, next: T | null | undefined): T | null =>
    isFilled(next) ? (next as T) : (current ?? null);

  // Extras merge field-by-field with the same "never clobber a filled value"
  // rule, so a late turn that fills systemType doesn't wipe an earlier brand.
  const mergedExtras: Record<string, unknown> = { ...(known.extras ?? {}) };
  const updateExtras = updates.extras ?? {};
  for (const key of EXTRA_SLOT_KEYS) {
    const next = (updateExtras as Record<string, unknown>)[key];
    if (isFilled(next)) mergedExtras[key] = next;
  }

  return {
    issueType: pick(known.issueType, updates.issueType),
    urgency: pick(known.urgency, updates.urgency),
    address: pick(known.address, updates.address),
    name: pick(known.name, updates.name),
    phone: pick(known.phone, updates.phone),
    email: pick(known.email, updates.email),
    extras: mergedExtras as ExtraSlots,
  };
}

/** True if any slot carries data worth persisting. */
export function hasSlotData(slots: KnownSlots): boolean {
  return (
    isFilled(slots.issueType) ||
    isFilled(slots.urgency) ||
    isFilled(slots.address) ||
    isFilled(slots.name) ||
    isFilled(slots.phone) ||
    isFilled(slots.email) ||
    Object.keys(slots.extras ?? {}).length > 0
  );
}

/** Build an ExtractionResult (the metadata shape the frontend + confirm endpoint expect). */
export function buildExtraction(
  slots: KnownSlots,
  description: string,
): ExtractionResult {
  return {
    issueType: slots.issueType ?? null,
    urgency: slots.urgency ?? null,
    address: slots.address ?? null,
    customerName: slots.name ?? null,
    customerPhone: slots.phone ?? null,
    customerEmail: slots.email ?? null,
    description: description.length > 0 ? description : "HVAC issue reported via chat",
    isHvacRelated: true,
    ...(slots.extras ?? {}),
  };
}
