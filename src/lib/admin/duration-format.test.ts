import { describe, it, expect } from "vitest";
import { humanizeSeconds } from "./duration-format";

describe("humanizeSeconds", () => {
  it("formats hours and minutes", () => {
    expect(humanizeSeconds(7500)).toBe("2h 5m"); // 2h 5m exactly
  });

  it("formats the live-probed evidence values", () => {
    expect(humanizeSeconds(5940)).toBe("1h 39m"); // on_the_way
    expect(humanizeSeconds(108756)).toBe("30h 13m"); // in_progress
  });

  it("formats minutes only under an hour", () => {
    expect(humanizeSeconds(2700)).toBe("45m");
  });

  it("formats whole hours without minutes", () => {
    expect(humanizeSeconds(7200)).toBe("2h");
  });

  it("formats sub-minute positive values as <1m", () => {
    expect(humanizeSeconds(29)).toBe("<1m");
  });

  it("formats zero as 0m", () => {
    expect(humanizeSeconds(0)).toBe("0m");
  });

  it("returns null for null/undefined/negative/non-finite", () => {
    expect(humanizeSeconds(null)).toBeNull();
    expect(humanizeSeconds(undefined)).toBeNull();
    expect(humanizeSeconds(-5)).toBeNull();
    expect(humanizeSeconds(Number.NaN)).toBeNull();
    expect(humanizeSeconds(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds 30+ seconds up to the next minute", () => {
    expect(humanizeSeconds(90)).toBe("2m"); // 1.5 min rounds to 2
  });
});
