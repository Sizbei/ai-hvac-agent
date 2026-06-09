/**
 * Customer-facing scheduling prompt copy.
 *
 * The intake's preferred-window step (triage WINDOW_STEP) asks the customer for a
 * TIME-OF-DAY PREFERENCE only — it does NOT offer or commit to a concrete dated
 * window. Per the business rule, the bot never quotes a time/slot; the team
 * coordinates the actual time with the customer after the request is in. So this
 * always asks a soft preference and never names a date.
 *
 * It still takes an OpenAvailability so the call site / seam stays unchanged, but
 * deliberately ignores the specifics — availability is consumed elsewhere (admin
 * scheduling), never surfaced as a promise to the customer here. Pure, no I/O.
 *
 * The chips' VALUES stay the existing enum (morning/afternoon/evening/asap) so
 * captureEnrichmentAnswer + the schema continue to accept them unchanged.
 *
 * PII GUARANTEE: OpenAvailability carries only counts, so nothing here can leak a
 * technician name/id (and nothing about it is shown to the customer regardless).
 */
import type { OpenAvailability } from "@/lib/admin/types";

/** A quick-reply chip the intake can render: a label + the value to capture.
 * Mirrors the triage step's quickReplies shape so the chat route appends them
 * the same way. */
export interface WindowChip {
  readonly label: string;
  readonly value: string;
}

/** The soft time-of-day preference prompt. No date, no committed window — the
 * team coordinates the actual time later. The `availability` arg is accepted to
 * keep the call site stable but is intentionally unused. */
export function buildWindowPrompt(
  _availability: OpenAvailability,
): { readonly question: string; readonly chips: readonly WindowChip[] } {
  return {
    question:
      "Any preference on time of day? Our team coordinates the actual time with you.",
    chips: [
      { label: "Morning", value: "morning" },
      { label: "Afternoon", value: "afternoon" },
      { label: "Evening", value: "evening" },
      { label: "No preference", value: "asap" },
    ],
  };
}
