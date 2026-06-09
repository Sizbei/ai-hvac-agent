import { describe, it, expect } from "vitest";
import { buildWindowPrompt } from "./availability-prompt";
import type { OpenAvailability } from "@/lib/admin/types";

describe("buildWindowPrompt", () => {
  it("offers concrete open bands on the next bookable day, with an ASAP chip", () => {
    const availability: OpenAvailability = {
      days: ["2026-07-01", "2026-07-02"],
      windows: [
        { day: "2026-07-01", window: "morning", capacity: 2, available: 1 },
        { day: "2026-07-01", window: "afternoon", capacity: 2, available: 0 },
        { day: "2026-07-01", window: "evening", capacity: 2, available: 2 },
      ],
    };
    const { question, chips } = buildWindowPrompt(availability);
    // Names the day (Jul 1) and drops the "we'll confirm the exact time" hedge.
    expect(question).toContain("Jul 1");
    expect(question).not.toContain("confirm the exact time");
    // Only bands with available > 0 (morning, evening) + ASAP.
    expect(chips.map((c) => c.value)).toEqual(["morning", "evening", "asap"]);
  });

  it("orders bands morning → afternoon → evening regardless of input order", () => {
    const availability: OpenAvailability = {
      days: ["2026-07-01"],
      windows: [
        { day: "2026-07-01", window: "evening", capacity: 1, available: 1 },
        { day: "2026-07-01", window: "morning", capacity: 1, available: 1 },
        { day: "2026-07-01", window: "afternoon", capacity: 1, available: 1 },
      ],
    };
    const { chips } = buildWindowPrompt(availability);
    expect(chips.map((c) => c.value)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "asap",
    ]);
  });

  it("skips fully-booked days and uses the first day with an opening", () => {
    const availability: OpenAvailability = {
      days: ["2026-07-01", "2026-07-02"],
      windows: [
        { day: "2026-07-01", window: "morning", capacity: 1, available: 0 },
        { day: "2026-07-02", window: "afternoon", capacity: 1, available: 1 },
      ],
    };
    const { question, chips } = buildWindowPrompt(availability);
    expect(question).toContain("Jul 2");
    expect(chips.map((c) => c.value)).toEqual(["afternoon", "asap"]);
  });

  it("falls back to the generic question when nothing is open", () => {
    const availability: OpenAvailability = {
      days: ["2026-07-01"],
      windows: [
        { day: "2026-07-01", window: "morning", capacity: 1, available: 0 },
      ],
    };
    const { question, chips } = buildWindowPrompt(availability);
    expect(question).toContain("We'll confirm the exact time");
    expect(chips.map((c) => c.value)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "asap",
    ]);
  });

  it("falls back when availability is empty", () => {
    const { question, chips } = buildWindowPrompt({ days: [], windows: [] });
    expect(question).toContain("When works best");
    expect(chips).toHaveLength(4);
  });

  it("keeps chip values as the existing enum so capture stays deterministic", () => {
    const availability: OpenAvailability = {
      days: ["2026-07-01"],
      windows: [
        { day: "2026-07-01", window: "morning", capacity: 1, available: 1 },
      ],
    };
    const { chips } = buildWindowPrompt(availability);
    const allowed = new Set(["morning", "afternoon", "evening", "asap"]);
    expect(chips.every((c) => allowed.has(c.value))).toBe(true);
  });
});
