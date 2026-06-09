import { describe, it, expect } from "vitest";
import { buildWindowPrompt } from "./availability-prompt";
import type { OpenAvailability } from "@/lib/admin/types";

// The bot no longer offers concrete dated slots — it asks a soft time-of-day
// PREFERENCE only and never quotes/commits to a specific time or window (the
// team coordinates the actual time with the customer later). buildWindowPrompt
// still accepts an OpenAvailability to keep the call site stable, but ignores
// the specifics: the same prompt comes out regardless of what's "open".

const WITH_OPENINGS: OpenAvailability = {
  days: ["2026-07-01", "2026-07-02"],
  windows: [
    { day: "2026-07-01", window: "morning", capacity: 2, available: 1 },
    { day: "2026-07-01", window: "afternoon", capacity: 2, available: 0 },
    { day: "2026-07-01", window: "evening", capacity: 2, available: 2 },
  ],
};

describe("buildWindowPrompt", () => {
  it("asks a soft time-of-day preference, never naming a concrete date", () => {
    const { question } = buildWindowPrompt(WITH_OPENINGS);
    expect(question).toMatch(/preference on time of day/i);
    // No concrete date and no time/window commitment language.
    expect(question).not.toMatch(/Jul \d/);
    expect(question).not.toMatch(/next opening/i);
    expect(question).not.toMatch(/confirm the exact time/i);
  });

  it("makes clear the team coordinates the actual time", () => {
    const { question } = buildWindowPrompt(WITH_OPENINGS);
    expect(question).toMatch(/team coordinates the actual time/i);
  });

  it("offers the four preference chips regardless of availability", () => {
    const open = buildWindowPrompt(WITH_OPENINGS);
    const empty = buildWindowPrompt({ days: [], windows: [] });
    expect(open.chips.map((c) => c.value)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "asap",
    ]);
    // Same prompt whether or not anything is "open" — availability is ignored.
    expect(empty.question).toBe(open.question);
    expect(empty.chips).toEqual(open.chips);
  });

  it("keeps chip values as the existing enum so capture stays deterministic", () => {
    const { chips } = buildWindowPrompt(WITH_OPENINGS);
    const allowed = new Set(["morning", "afternoon", "evening", "asap"]);
    expect(chips.every((c) => allowed.has(c.value))).toBe(true);
  });
});
