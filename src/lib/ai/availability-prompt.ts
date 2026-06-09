/**
 * Customer-facing scheduling prompt copy — Stage 5.2.
 *
 * The intake's preferred-window step (triage WINDOW_STEP) historically asked a
 * generic "When works best? (We'll confirm the exact time.)". Now that we can
 * compute REAL open windows (lib/admin/availability), we offer the customer the
 * concrete next-business-day bands that actually have capacity, instead of a
 * placeholder. This module is PURE: it turns an already-computed OpenAvailability
 * (fetched server-side through the scheduling-source seam) into prompt copy +
 * quick-reply chips. No I/O, no Date.now() — unit-tests deterministically.
 *
 * COORDINATION with after-hours (after-hours-chat.ts): this only shapes the
 * WHICH-WINDOW question. The after-hours decision still OWNS the turn's framing
 * when an intake is after-hours (the chat route composes one coherent message);
 * we never duplicate the urgent/next-day/charge logic here. The bands we offer
 * are next-BUSINESS-day windows, which is exactly the no-charge path after-hours
 * already steers toward.
 *
 * PII GUARANTEE: OpenAvailability carries only counts, so nothing here can leak a
 * technician name/id.
 */
import type { OpenAvailability, OpenWindow } from "@/lib/admin/types";

/** Human label for a band value. `asap` is the always-available urgent option. */
const WINDOW_LABELS: Record<string, string> = {
  morning: "Morning (8am–12pm)",
  afternoon: "Afternoon (12–4pm)",
  evening: "Evening (4–8pm)",
};

/** Short month-day label for a business-tz ISO date, e.g. "Jun 10". Rendered in
 * a fixed way (no timezone math) since the date is already a business-tz day. */
function shortDayLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  if (!y || !m || !d || m < 1 || m > 12) return isoDay;
  return `${MONTHS[m - 1]} ${d}`;
}

/** A quick-reply chip the intake can render: a label + the value to capture.
 * Mirrors the triage step's quickReplies shape so the chat route appends them
 * the same way. */
export interface WindowChip {
  readonly label: string;
  readonly value: string;
}

/**
 * The bookable bands (available > 0) on the EARLIEST day in `availability` that
 * has any open window — the next bookable business day. We surface one day's
 * worth of concrete options to keep the question short; deeper ranges are handled
 * by the dispatcher / a follow-up.
 */
function nextBookableDay(
  availability: OpenAvailability,
): { readonly day: string; readonly windows: readonly OpenWindow[] } | null {
  for (const day of availability.days) {
    const open = availability.windows.filter(
      (w) => w.day === day && w.available > 0,
    );
    if (open.length > 0) return { day, windows: open };
  }
  return null;
}

/** Order bands morning → afternoon → evening for a stable presentation. */
const BAND_ORDER: Record<string, number> = {
  morning: 0,
  afternoon: 1,
  evening: 2,
};

/**
 * Build the preferred-window prompt + chips from real availability.
 *
 * - When at least one band is open on an upcoming business day: offer those
 *   concrete bands (with the day named once) plus an always-present "ASAP" chip
 *   for urgent callers, and DROP the "we'll confirm the exact time" hedge — we're
 *   offering real windows now.
 * - When nothing is open in range (no availability configured, or fully booked):
 *   fall back to the generic question + chips so the intake never stalls.
 *
 * The chips' VALUES stay the existing enum (morning/afternoon/evening/asap) so
 * captureEnrichmentAnswer + the schema continue to accept them unchanged — only
 * the labels and surrounding copy get richer.
 */
export function buildWindowPrompt(
  availability: OpenAvailability,
): { readonly question: string; readonly chips: readonly WindowChip[] } {
  const next = nextBookableDay(availability);

  // No real openings to offer → generic fallback (same intent as the old copy).
  if (!next) {
    return {
      question: "When works best for a visit? (We'll confirm the exact time.)",
      chips: [
        { label: "Morning", value: "morning" },
        { label: "Afternoon", value: "afternoon" },
        { label: "Evening", value: "evening" },
        { label: "ASAP", value: "asap" },
      ],
    };
  }

  const ordered = [...next.windows].sort(
    (a, b) => (BAND_ORDER[a.window] ?? 99) - (BAND_ORDER[b.window] ?? 99),
  );
  const dayLabel = shortDayLabel(next.day);
  const chips: WindowChip[] = ordered.map((w) => ({
    label: WINDOW_LABELS[w.window] ?? w.window,
    value: w.window,
  }));
  // Always let an urgent caller bypass the listed bands.
  chips.push({ label: "ASAP", value: "asap" });

  const question = `Our next openings are on ${dayLabel} — which window works best for you?`;
  return { question, chips };
}
