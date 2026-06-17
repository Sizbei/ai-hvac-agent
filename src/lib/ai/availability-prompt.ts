/**
 * Customer-facing scheduling prompt copy.
 *
 * The intake's preferred-window step (triage WINDOW_STEP) captures a PREFERENCE
 * only — it offers concrete open day/time-band options derived from REAL
 * availability, but it never books, quotes, or commits to a specific time. Per
 * the business rule the team coordinates the actual time with the customer after
 * the request is in; the customer (web) still taps Confirm & Submit and staff
 * still finalize. So the copy here is strictly an OFFER OF OPTIONS — no
 * "booked"/"scheduled"/"confirmed"/"you're all set" language ever.
 *
 * It consumes the OpenAvailability the route fetches (CHATBOT-PLAN Step 11+6):
 * it surfaces up to a few concrete BOOKABLE bands (e.g. "Tue morning, Wed
 * afternoon, Thu morning") as a preference ask. When availability is empty/null
 * (no openings, or the lookup failed) it falls back to the generic soft
 * time-of-day question — it NEVER errors. Pure, no I/O.
 *
 * The chips' VALUES stay the existing band enum (morning/afternoon/evening/asap)
 * so captureEnrichmentAnswer + the schema continue to accept them unchanged; the
 * chip LABEL carries the concrete day so the customer sees a real option.
 *
 * PII GUARANTEE: OpenAvailability carries only day/band + counts, so nothing
 * here can leak a technician name/id.
 */
import type { OpenAvailability } from "@/lib/admin/types";
import { businessWallClockToUtc, BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";

/** A quick-reply chip the intake can render: a label + the value to capture.
 * Mirrors the triage step's quickReplies shape so the chat route appends them
 * the same way. */
export interface WindowChip {
  readonly label: string;
  readonly value: string;
}

/** The four soft-preference chips used when no concrete availability is offered
 * (empty/null availability). Values are the existing band enum. */
const FALLBACK_CHIPS: readonly WindowChip[] = [
  { label: "Morning", value: "morning" },
  { label: "Afternoon", value: "afternoon" },
  { label: "Evening", value: "evening" },
  { label: "No preference", value: "asap" },
];

const FALLBACK_QUESTION =
  "Any preference on time of day? Our team coordinates the actual time with you.";

/** Most concrete bands we surface — keep it short so the ask stays scannable. */
const MAX_OFFERED = 3;

/** Capitalize a band name for prose ("morning" → "morning" stays lowercase in
 * the sentence; the chip label title-cases the band). */
const BAND_LABEL: Record<string, string> = {
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
};

// Short weekday name ("Mon", "Tue", …) read in the BUSINESS timezone so a band
// always shows the day a customer would actually see, never the server's zone.
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: "short",
});

/** The short business-tz weekday name for an ISO date (YYYY-MM-DD). Anchored at
 * Eastern noon so a DST boundary never shifts the weekday. Returns null when the
 * date is unparseable, so the caller can skip a malformed band rather than throw. */
function businessWeekdayShort(isoDate: string): string | null {
  const instant = businessWallClockToUtc(isoDate, 12, 0);
  if (Number.isNaN(instant.getTime())) return null;
  return WEEKDAY_FORMATTER.format(instant);
}

/**
 * Build the preferred-window prompt from REAL open availability.
 *
 * When `availability` has bookable bands (available > 0) it offers up to three
 * concrete "Day band" options (e.g. "Tue morning") as a PREFERENCE ask. When it
 * has none (empty, null, or every band fully booked) it falls back to the
 * generic soft time-of-day question. Never commits to a time; never errors.
 *
 * The chip VALUE is always the band enum (morning/afternoon/evening) so capture
 * stays deterministic; the LABEL carries the concrete day so the option reads
 * like a real opening. A trailing "no preference" chip lets the customer defer.
 */
export function buildWindowPrompt(
  availability: OpenAvailability | null | undefined,
): { readonly question: string; readonly chips: readonly WindowChip[] } {
  const bookable = (availability?.windows ?? []).filter(
    (w) => w.available > 0 && BAND_LABEL[w.window] !== undefined,
  );

  // No real openings → the generic soft-preference ask (unchanged behavior).
  if (bookable.length === 0) {
    return { question: FALLBACK_QUESTION, chips: FALLBACK_CHIPS };
  }

  // Render up to MAX_OFFERED concrete bands. windows arrive day-then-window
  // ordered (see OpenAvailability), so taking the first few gives the soonest.
  const offered: { readonly label: string; readonly band: string }[] = [];
  for (const w of bookable) {
    if (offered.length >= MAX_OFFERED) break;
    const weekday = businessWeekdayShort(w.day);
    if (!weekday) continue; // skip a malformed date rather than throw
    offered.push({ label: `${weekday} ${BAND_LABEL[w.window]}`, band: w.window });
  }

  // Every candidate band had an unparseable date → fall back rather than emit an
  // empty offer (defensive; OpenAvailability dates are validated upstream).
  if (offered.length === 0) {
    return { question: FALLBACK_QUESTION, chips: FALLBACK_CHIPS };
  }

  const optionList = offered.map((o) => o.label).join(", ");
  // PREFERENCE phrasing only: "I can note a preferred time" — we OFFER options
  // and the team coordinates the actual time. No booking/confirmation language.
  const question = `I can note a preferred time — we have ${optionList} open. Which works best, or is another time better?`;

  const chips: WindowChip[] = offered.map((o) => ({
    label: o.label,
    value: o.band,
  }));
  // Always let the customer defer to "no preference" (captures as asap).
  chips.push({ label: "No preference", value: "asap" });

  return { question, chips };
}
