import { describe, it, expect } from "vitest";
import { estimateAgeDays, estimateTotalLabel } from "./estimate-list-display";

describe("estimateAgeDays", () => {
  const created = "2026-11-06T12:00:00.000Z";
  it("never shows a negative age when the client clock is behind the database", () => {
    expect(estimateAgeDays(created, Date.parse(created) - 50)).toBe(0);
  });
  it("counts whole days", () => {
    expect(estimateAgeDays(created, Date.parse(created) + 86_400_000 * 3 + 5)).toBe(3);
    expect(estimateAgeDays(created, Date.parse(created) + 86_400_000 - 1)).toBe(0);
  });
  it("is 0 for an unreadable date", () => {
    expect(estimateAgeDays("not a date", Date.now())).toBe(0);
  });
});

describe("estimateTotalLabel", () => {
  it('says "up to" for an undecided multi-option estimate', () => {
    expect(estimateTotalLabel({ totalCents: 37668, optionCount: 2, soldOptionId: null })).toBe(
      "up to $376.68",
    );
  });
  it("is the plain amount once sold or with one option", () => {
    expect(estimateTotalLabel({ totalCents: 27266, optionCount: 3, soldOptionId: "o1" })).toBe("$272.66");
    expect(estimateTotalLabel({ totalCents: 27266, optionCount: 1, soldOptionId: null })).toBe("$272.66");
    expect(estimateTotalLabel({ totalCents: 27266, optionCount: 0, soldOptionId: null })).toBe("$272.66");
  });
});
