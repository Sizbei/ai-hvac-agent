import { describe, expect, it } from "vitest";

import { parseFpDate } from "./fp-dates";

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
