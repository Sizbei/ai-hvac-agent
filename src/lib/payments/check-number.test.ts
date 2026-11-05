import { describe, expect, it } from "vitest";
import { CHECK_NUMBER_PATTERN, isValidCheckNumber } from "./check-number";

describe("check numbers", () => {
  it("accepts letters, digits and dashes up to 32 characters", () => {
    expect(isValidCheckNumber("1042")).toBe(true);
    expect(isValidCheckNumber(" A-77 ")).toBe(true);
    expect(isValidCheckNumber("x".repeat(32))).toBe(true);
  });
  it("refuses free text, symbols and over-long values", () => {
    expect(isValidCheckNumber("#1234")).toBe(false);
    expect(isValidCheckNumber("Chk 1234")).toBe(false);
    expect(isValidCheckNumber("Jane Doe chk 4471")).toBe(false);
    expect(isValidCheckNumber("")).toBe(false);
    expect(isValidCheckNumber("x".repeat(33))).toBe(false);
  });
  it("is the one pattern the routes use", () => {
    expect(CHECK_NUMBER_PATTERN.source).toBe("^[A-Za-z0-9-]{1,32}$");
  });
});
