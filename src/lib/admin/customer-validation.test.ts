import { describe, it, expect } from "vitest";
import { phoneInputError, saveErrorMessage } from "./customer-validation";

describe("phoneInputError", () => {
  it.each([
    "",
    "   ",
    "(423) 555-0187",
    "423-555-0187",
    "4235550187",
    "1-423-555-0187",
    "+1 (423) 555-0187",
    "+44 20 7946 0958",
    "423-555-0187 x12",
    "423.555.0187 ext. 4",
  ])("accepts %j", (v) => {
    expect(phoneInputError(v)).toBeNull();
  });

  it.each(["12", "423-555-01", "555-0187", "2-423-555-0187", "call me", "423555018712345"])(
    "rejects %j",
    (v) => {
      expect(phoneInputError(v)).toMatch(/^Enter a/);
    },
  );

  it("treats null as empty", () => {
    expect(phoneInputError(null)).toBeNull();
  });
});


describe("saveErrorMessage", () => {
  const fallback = "Couldn't save the customer. Please try again.";
  it("passes through our validation and conflict messages", () => {
    expect(saveErrorMessage(400, { error: { message: "Name is required" } }, fallback)).toBe(
      "Name is required",
    );
    expect(saveErrorMessage(409, { error: { message: "Already exists" } }, fallback)).toBe(
      "Already exists",
    );
  });
  it("hides server errors, rate limits and network failures", () => {
    expect(saveErrorMessage(500, { error: { message: "Internal server error" } }, fallback)).toBe(
      fallback,
    );
    expect(saveErrorMessage(429, { error: { message: "Rate limit exceeded" } }, fallback)).toBe(
      fallback,
    );
    expect(saveErrorMessage(null, null, fallback)).toBe(fallback);
    expect(saveErrorMessage(400, {}, fallback)).toBe(fallback);
  });
});
