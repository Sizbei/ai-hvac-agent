import { describe, expect, it } from "vitest";

import { earlierFpDate, parseFpDate } from "./fp-dates";

describe("parseFpDate", () => {
  it("parses FieldPulse datetime strings (space-separated, no zone)", () => {
    const d = parseFpDate("2026-07-01 10:00:00");
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
  });

  it("parses FieldPulse date-only strings", () => {
    const d = parseFpDate("2026-08-01");
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(Date.UTC(2026, 7, 1));
  });

  it("parses ISO strings with zone untouched", () => {
    const d = parseFpDate("2026-07-01T10:00:00Z");
    expect(d!.getTime()).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
  });

  it("returns null for null/undefined/empty", () => {
    expect(parseFpDate(null)).toBeNull();
    expect(parseFpDate(undefined)).toBeNull();
    expect(parseFpDate("")).toBeNull();
    expect(parseFpDate("   ")).toBeNull();
  });

  it("returns null for garbage instead of Invalid Date", () => {
    expect(parseFpDate("not-a-date")).toBeNull();
    expect(parseFpDate("0000-00-00 00:00:00")).toBeNull();
  });
});

describe("earlierFpDate", () => {
  const importDay = new Date("2026-07-09T08:17:17Z");

  it("returns FieldPulse's date when it is earlier than the stored one", () => {
    const fp = new Date("2026-06-12T14:00:00Z");
    expect(earlierFpDate(importDay, fp)).toBe(fp);
  });

  it("returns null when FieldPulse's date is the same or later", () => {
    expect(earlierFpDate(importDay, new Date(importDay.getTime()))).toBeNull();
    expect(earlierFpDate(importDay, new Date("2026-07-09T08:17:30Z"))).toBeNull();
  });

  it("returns null when FieldPulse sent no date", () => {
    expect(earlierFpDate(importDay, null)).toBeNull();
  });
});
