import { describe, it, expect } from "vitest";
import { instantHasPassed, windowHasEnded } from "./window-ended";

describe("windowHasEnded", () => {
  // Nov 5 2026 is EST (UTC−5): morning = 13:00–17:00Z, evening = 21:00–01:00Z.
  it("is true only once the band's end has passed in business time", () => {
    const at = (iso: string) => new Date(iso);
    expect(windowHasEnded("2026-11-05", "morning", at("2026-11-05T16:59:00Z"))).toBe(false);
    expect(windowHasEnded("2026-11-05", "morning", at("2026-11-05T17:00:00Z"))).toBe(true);
    // 8:05 PM Eastern is already the next UTC day: the evening band is over.
    expect(windowHasEnded("2026-11-05", "evening", at("2026-11-06T01:05:00Z"))).toBe(true);
    expect(windowHasEnded("2026-11-06", "morning", at("2026-11-06T01:05:00Z"))).toBe(false);
  });
});

describe("instantHasPassed", () => {
  it("compares an ISO end with now; garbage never counts as passed", () => {
    const now = new Date("2026-11-05T18:00:00Z");
    expect(instantHasPassed("2026-11-05T17:00:00.000Z", now)).toBe(true);
    expect(instantHasPassed("2026-11-05T18:00:00.000Z", now)).toBe(true);
    expect(instantHasPassed("2026-11-05T21:00:00.000Z", now)).toBe(false);
    expect(instantHasPassed("not a date", now)).toBe(false);
  });
});
