import type { KnownSlots } from "./intent-router";
import type { ExtractionResult } from "./extraction-schema";

/**
 * Helpers for moving extracted slots between the session's `metadata` column
 * (stored as an `ExtractionResult` JSON string) and the router's `KnownSlots`
 * shape, with merge semantics that NEVER overwrite a filled slot with an empty
 * value (review finding H2).
 */

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Parse the session metadata JSON string into router KnownSlots. */
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
  return {
    issueType: pick(known.issueType, updates.issueType),
    urgency: pick(known.urgency, updates.urgency),
    address: pick(known.address, updates.address),
    name: pick(known.name, updates.name),
    phone: pick(known.phone, updates.phone),
    email: pick(known.email, updates.email),
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
    isFilled(slots.email)
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
  };
}
