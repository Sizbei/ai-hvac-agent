/**
 * Client-side bridge: derive the NEXT triage step (and its tappable quick-reply
 * chips) from the polled extraction snapshot — Stage 5.3 (#3 structured inputs).
 *
 * The chat reply is a plain TEXT stream, so the server's per-turn triage chips
 * never reach the client as structured data — they're flattened into the question
 * text ("(Morning · Afternoon · Evening)"). The client DOES poll `/api/session`
 * and gets the `ExtractionResult` metadata, which carries the same slot facts.
 *
 * This module reconstructs the triage view client-side: it maps the FLAT
 * ExtractionResult (top-level optional intake fields) into the `extras` bag shape
 * `nextTriageStep` reasons over, runs the SAME pure triage engine, and returns the
 * next step's quick-replies as tappable chips. Because it reuses `nextTriageStep`,
 * the client and server always agree on what's being asked.
 *
 * Pure, no I/O — unit-tests without a DB or network.
 *
 * LIMITATIONS (deliberate):
 *  - The real-availability window LABELS (e.g. "Morning (8am–12pm)" on a named
 *    day) are computed server-side (availability-prompt.ts) and aren't in the
 *    extraction snapshot. Client chips use the triage step's STANDARD labels
 *    (Morning / Afternoon / Evening / ASAP). The VALUES are identical, so a tap
 *    captures the same enum the server expects — only the label richness differs.
 *  - Free-text steps (address, phone, name, duration, brand, access notes) have no
 *    chips; the customer types those. We only surface chips for enum/choice steps.
 *  - Safety is treated as cleared here: a real hazard escalates server-side before
 *    this view ever renders, mirroring the route's nextSlotPrompt convention.
 */
import type { ExtractionResult } from "./extraction-schema";
import { nextTriageStep, type TriageSlots, type QuickReply } from "./triage";

/** The extraction fields that map into the triage `extras` bag, by extras key.
 * Mirrors triage.STEP_TO_EXTRA — kept here as the client doesn't import that
 * private map. Each is an optional intake field on ExtractionResult. */
const EXTRA_KEYS = [
  "systemDownStatus",
  "problemDuration",
  "systemType",
  "equipmentAgeBand",
  "equipmentBrand",
  "propertyType",
  "ownerOccupant",
  "underWarranty",
  "accessNotes",
  "vulnerableOccupants",
  "preferredWindow",
  "contactPreference",
  "leadSource",
] as const;

/**
 * Lift the flat ExtractionResult into the TriageSlots shape `nextTriageStep`
 * expects: core fields stay top-level; the optional intake fields move into the
 * `extras` bag under their own names (only when actually set, so an unanswered
 * step still surfaces as the next question).
 */
export function extractionToTriageSlots(
  extraction: ExtractionResult,
): TriageSlots {
  const extras: Record<string, unknown> = {};
  for (const key of EXTRA_KEYS) {
    const value = (extraction as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== "") {
      extras[key] = value;
    }
  }
  return {
    issueType: extraction.issueType ?? null,
    urgency: extraction.urgency ?? null,
    address: extraction.address ?? null,
    name: extraction.customerName ?? null,
    phone: extraction.customerPhone ?? null,
    email: extraction.customerEmail ?? null,
    // A real hazard escalates server-side before this client view renders, so we
    // sequence the remaining intake as if the safety screen is cleared (same
    // convention the chat route's nextSlotPrompt uses).
    safetyScreenPassed: true,
    extras,
  };
}

/**
 * The tappable quick-reply chips to show under the latest assistant message,
 * derived from the polled extraction. Returns [] when:
 *  - there's no extraction yet,
 *  - intake is complete (triage returns null),
 *  - the next step is a free-text step (no chips to tap).
 *
 * The returned chip `value` is exactly what the customer's message becomes when
 * tapped (the server captures it deterministically), and `label` is the display
 * text. Callers render these as buttons that send `value` as a chat message.
 */
export function chipsForExtraction(
  extraction: ExtractionResult | null,
): readonly QuickReply[] {
  if (!extraction) return [];
  const step = nextTriageStep(extractionToTriageSlots(extraction));
  if (!step) return [];
  return step.quickReplies;
}

/**
 * The id of the triage step currently being asked (or null when intake is
 * complete / there's no extraction yet). Lets the client render step-specific UI
 * — e.g. the address autocomplete only when the address (or city/ZIP follow-up)
 * step is pending — using the SAME engine the server sequences with.
 */
export function nextStepIdForExtraction(
  extraction: ExtractionResult | null,
): string | null {
  if (!extraction) return null;
  return nextTriageStep(extractionToTriageSlots(extraction))?.id ?? null;
}
