import { describe, it, expect } from "vitest";
import { referenceSearchPatterns } from "./request-search";

describe("referenceSearchPatterns", () => {
  it("matches a bare fragment with or without the HVAC- prefix", () => {
    expect(referenceSearchPatterns("cf94")).toEqual(["cf94%", "HVAC-cf94%"]);
  });
  it("keeps a typed prefix as a single pattern, any case", () => {
    expect(referenceSearchPatterns("HVAC-CF94")).toEqual(["HVAC-CF94%"]);
    expect(referenceSearchPatterns("hvac-cf94")).toEqual(["hvac-cf94%"]);
  });
  it("trims and escapes LIKE metacharacters", () => {
    expect(referenceSearchPatterns("  a_b%  ")).toEqual(["a\\_b\\%%", "HVAC-a\\_b\\%%"]);
  });
  it("returns nothing for a blank term", () => {
    expect(referenceSearchPatterns("   ")).toEqual([]);
    expect(referenceSearchPatterns(undefined)).toEqual([]);
  });
});
