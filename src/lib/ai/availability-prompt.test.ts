import { describe, it, expect } from "vitest";
import { buildWindowPrompt } from "./availability-prompt";
import type { OpenAvailability } from "@/lib/admin/types";

// buildWindowPrompt now CONSUMES real availability (CHATBOT-PLAN Step 11+6): it
// offers up to three concrete bookable day/band options as a PREFERENCE ask, and
// falls back to a generic soft time-of-day question when nothing is open. It must
// NEVER use commitment language (booked/scheduled/confirmed) — a window is a
// preference the team coordinates later, not a booking.

const COMMITMENT_REGEX =
  /\b(booked|scheduled|confirmed|you'?re all set|reserved)\b/i;

const WITH_OPENINGS: OpenAvailability = {
  // Tue/Wed/Thu (business-tz / Eastern weekdays for these dates).
  days: ["2026-07-07", "2026-07-08", "2026-07-09"],
  windows: [
    { day: "2026-07-07", window: "morning", capacity: 2, available: 1 },
    { day: "2026-07-07", window: "afternoon", capacity: 2, available: 0 },
    { day: "2026-07-08", window: "afternoon", capacity: 2, available: 2 },
    { day: "2026-07-09", window: "morning", capacity: 1, available: 1 },
  ],
};

describe("buildWindowPrompt — real availability", () => {
  it("offers concrete day/time-band options derived from open slots", () => {
    const { question } = buildWindowPrompt(WITH_OPENINGS);
    // The three bookable bands (afternoon on 07-07 is fully booked → skipped).
    expect(question).toContain("Tue morning");
    expect(question).toContain("Wed afternoon");
    expect(question).toContain("Thu morning");
    // The fully-booked band must NOT be offered.
    expect(question).not.toContain("Tue afternoon");
  });

  it("phrases it as a preference, never a commitment", () => {
    const { question } = buildWindowPrompt(WITH_OPENINGS);
    expect(question).toMatch(/preferred time/i);
    expect(question).not.toMatch(COMMITMENT_REGEX);
  });

  it("caps the offer at three concrete bands so the ask stays scannable", () => {
    const many: OpenAvailability = {
      days: ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"],
      windows: [
        { day: "2026-07-07", window: "morning", capacity: 2, available: 2 },
        { day: "2026-07-07", window: "afternoon", capacity: 2, available: 2 },
        { day: "2026-07-08", window: "morning", capacity: 2, available: 2 },
        { day: "2026-07-08", window: "evening", capacity: 2, available: 2 },
        { day: "2026-07-09", window: "morning", capacity: 2, available: 2 },
      ],
    };
    const { chips } = buildWindowPrompt(many);
    // Three concrete bands + the trailing "No preference" defer chip.
    expect(chips.length).toBe(4);
    expect(chips[chips.length - 1]!.value).toBe("asap");
  });

  it("keeps chip VALUES the existing band enum so capture stays deterministic", () => {
    const { chips } = buildWindowPrompt(WITH_OPENINGS);
    const allowed = new Set(["morning", "afternoon", "evening", "asap"]);
    expect(chips.every((c) => allowed.has(c.value))).toBe(true);
    // But the LABEL carries the concrete day so the customer sees a real option.
    expect(chips[0]!.label).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (morning|afternoon|evening)$/);
  });

  it("renders weekday labels in the business timezone (Eastern)", () => {
    // 2026-07-07 is a Tuesday in Eastern; assert the label reflects that.
    const { chips } = buildWindowPrompt({
      days: ["2026-07-07"],
      windows: [{ day: "2026-07-07", window: "morning", capacity: 1, available: 1 }],
    });
    expect(chips[0]!.label).toBe("Tue morning");
  });
});

describe("buildWindowPrompt — fallback when nothing is open", () => {
  it("falls back to the generic soft preference when there are no openings", () => {
    const empty = buildWindowPrompt({ days: [], windows: [] });
    expect(empty.question).toMatch(/preference on time of day/i);
    expect(empty.question).toMatch(/team coordinates the actual time/i);
    expect(empty.chips.map((c) => c.value)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "asap",
    ]);
  });

  it("falls back when every band is fully booked (available === 0)", () => {
    const allBooked = buildWindowPrompt({
      days: ["2026-07-07"],
      windows: [{ day: "2026-07-07", window: "morning", capacity: 1, available: 0 }],
    });
    expect(allBooked.question).toMatch(/preference on time of day/i);
  });

  it("falls back (never throws) on null/undefined availability", () => {
    expect(buildWindowPrompt(null).question).toMatch(/preference on time of day/i);
    expect(buildWindowPrompt(undefined).question).toMatch(/preference on time of day/i);
  });

  it("never uses commitment language in any branch", () => {
    expect(buildWindowPrompt(WITH_OPENINGS).question).not.toMatch(COMMITMENT_REGEX);
    expect(buildWindowPrompt({ days: [], windows: [] }).question).not.toMatch(
      COMMITMENT_REGEX,
    );
  });
});
