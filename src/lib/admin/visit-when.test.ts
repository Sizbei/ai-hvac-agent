import { describe, expect, it } from "vitest";
import { businessDateLabel, visitWhenLabel } from "./visit-when";

// July is EDT (UTC-4): 8 AM ET = 12:00Z.
describe("visitWhenLabel", () => {
  it("names a standard band only when the window fills it exactly", () => {
    expect(visitWhenLabel("2026-07-13T12:00:00.000Z", "2026-07-13T16:00:00.000Z", null)).toBe(
      "Mon, Jul 13 Morning (8am–12pm)",
    );
  });
  it("shows the real times for an imported 8–10 AM window", () => {
    expect(visitWhenLabel("2026-07-13T12:00:00.000Z", "2026-07-13T14:00:00.000Z", null)).toBe(
      "Mon, Jul 13 · 8 AM–10 AM",
    );
  });
  it("shows minutes when the window has them", () => {
    expect(visitWhenLabel("2026-07-15T12:00:00.000Z", "2026-07-15T13:30:00.000Z", null)).toBe(
      "Wed, Jul 15 · 8 AM–9:30 AM",
    );
  });
  it("uses the business day, not the UTC day", () => {
    // 11 PM ET Jul 13 = 03:00Z Jul 14.
    expect(visitWhenLabel("2026-07-14T03:00:00.000Z", "2026-07-14T04:00:00.000Z", null)).toBe(
      "Mon, Jul 13 · 11 PM–12 AM",
    );
  });
  it("falls back to the start time when the end is missing or not after the start", () => {
    expect(visitWhenLabel("2026-07-13T12:00:00.000Z", null, null)).toBe("Mon, Jul 13 · 8:00 AM");
    expect(visitWhenLabel("2026-07-13T12:00:00.000Z", "2026-07-13T12:00:00.000Z", null)).toBe(
      "Mon, Jul 13 · 8:00 AM",
    );
  });
  it("uses the scheduled day, or says not scheduled", () => {
    expect(visitWhenLabel(null, null, "2026-07-13T00:00:00.000Z")).toBe("Mon, Jul 13");
    expect(visitWhenLabel(null, null, null)).toBe("Not scheduled");
    expect(visitWhenLabel("garbage", null, null)).toBe("Not scheduled");
  });
});

describe("businessDateLabel", () => {
  it("formats in business time", () => {
    // 1 AM UTC Jul 30 is still Jul 29 in Eastern time.
    expect(businessDateLabel("2026-07-30T01:00:00.000Z")).toBe("Jul 29, 2026");
  });
  it("returns null for missing or bad values", () => {
    expect(businessDateLabel(null)).toBeNull();
    expect(businessDateLabel("nope")).toBeNull();
  });
});
