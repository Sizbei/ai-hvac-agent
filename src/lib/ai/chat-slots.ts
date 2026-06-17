import type { KnownSlots } from "./intent-router";
import type { ExtractionResult } from "./extraction-schema";
import { sanitizeContactFields } from "./sanitize-fields";

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

// Internal control flags that ride along in the extras bag but are NOT part of
// the persisted ExtractionResult — the extraction schema strips unknown keys at
// the confirm endpoint, so these never reach the CRM. They exist only to
// sequence the conversation across turns:
//   - addressVerified: "yes" once the customer picked a geocoded suggestion, so
//     a "found" address is trusted even when it isn't a US-ZIP format.
//   - addressAttempts: how many times we've re-prompted for a complete US
//     address, so triage stops after MAX_ADDRESS_REPROMPTS instead of looping.
//   - emailAttempts: how many times we've asked for the email, so triage stops
//     after MAX_EMAIL_REPROMPTS and the intake proceeds without one instead of
//     re-asking the identical question forever.
//   - afterHoursShown: comma-joined after-hours moves already surfaced this
//     session (e.g. "ask_urgency,disclose_charge"), so each disclosure is said
//     AT MOST ONCE instead of being prepended to every intake turn.
//   - empathyShown: "1" once the deterministic path has emitted its one-time
//     issue acknowledgement, so the LLM seam doesn't restart the "Got it /
//     Understood" empathy decay (CHATBOT-PLAN Step 2).
//   - reAskStepId / reAskCount: the slot question asked last turn and how many
//     times in a row it's been asked, so the re-ask circuit breaker can switch
//     phrasing + offer skip/human after N identical asks (CHATBOT-PLAN Step 3).
//   - frustrationScore / frustrationOffered: running dissatisfaction signal count
//     and whether we've already proactively offered a human, so we offer once
//     before the turn-limit fallback (CHATBOT-PLAN Step 5).
// They merge/parse with the same never-clobber rule as the real slots.
export const CONTROL_SLOT_KEYS = [
  "addressVerified",
  "addressAttempts",
  "emailAttempts",
  "afterHoursShown",
  "empathyShown",
  "reAskStepId",
  "reAskCount",
  "frustrationScore",
  "frustrationOffered",
] as const;

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Pull the extra (non-core) slots — plus the internal control flags — out of a
 * parsed metadata object. */
function pickExtras(source: Partial<ExtractionResult>): ExtraSlots {
  const out: Record<string, unknown> = {};
  for (const key of [...EXTRA_SLOT_KEYS, ...CONTROL_SLOT_KEYS]) {
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
  for (const key of [...EXTRA_SLOT_KEYS, ...CONTROL_SLOT_KEYS]) {
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

// Sentinel a skipped optional step writes (see triage.SKIP_SENTINEL). It MUST
// stay in the session metadata (so the step isn't re-asked on reload), and is
// stripped only when the request is finally persisted (confirm route).
export const SKIP_SENTINEL = "__skipped__";

/** Drop skip-sentinel values from an extras bag (used at final persistence). */
export function stripSkipSentinels(
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extras)) {
    if (v !== SKIP_SENTINEL) out[k] = v;
  }
  return out;
}

/**
 * Build an ExtractionResult (the metadata shape the frontend + confirm endpoint
 * expect). Skip sentinels are preserved here because this result is written
 * back to the session metadata, which triage re-reads to know what was skipped.
 */
export function buildExtraction(
  slots: KnownSlots,
  description: string,
): ExtractionResult {
  // Sanitize the contact fields at the single chokepoint every persisted /
  // recapped extraction flows through: capitalize the name, format the phone,
  // tidy the address, lower-case the email. Slot extraction and the LLM store
  // raw values; this is where they become the clean record the customer sees in
  // the confirmation recap and the dispatcher sees in the CRM.
  return sanitizeContactFields({
    issueType: slots.issueType ?? null,
    urgency: slots.urgency ?? null,
    address: slots.address ?? null,
    customerName: slots.name ?? null,
    customerPhone: slots.phone ?? null,
    customerEmail: slots.email ?? null,
    description: description.length > 0 ? description : "HVAC issue reported via chat",
    isHvacRelated: true,
    ...(slots.extras ?? {}),
  });
}
