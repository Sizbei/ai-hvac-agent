import { describe, it, expect } from "vitest";
import { extractSpokenPhone } from "./extract-spoken-phone";

describe("extractSpokenPhone", () => {
  it("captures a digit-by-digit transcription with single-digit groups", () => {
    expect(extractSpokenPhone("8 6 5 5 5 5 1 2 1 2")).toBe("865-555-1212");
  });

  it("captures a grouped transcription", () => {
    expect(extractSpokenPhone("865 555 1212")).toBe("865-555-1212");
  });

  it("captures a number buried in filler words", () => {
    expect(extractSpokenPhone("my number is 8 6 5 5 5 5 1 2 1 2 thanks")).toBe(
      "865-555-1212",
    );
  });

  it("strips a leading country code 1 (11 digits)", () => {
    expect(extractSpokenPhone("1 8 6 5 5 5 5 1 2 1 2")).toBe("865-555-1212");
  });

  it("normalizes hyphenated/parenthesized forms", () => {
    expect(extractSpokenPhone("(865) 555-1212")).toBe("865-555-1212");
  });

  it("returns null when there are too few digits", () => {
    expect(extractSpokenPhone("call me at five five five")).toBeNull();
    expect(extractSpokenPhone("37604")).toBeNull();
  });

  it("returns null when there are too many digits and no leading 1", () => {
    expect(extractSpokenPhone("2 8 6 5 5 5 5 1 2 1 2")).toBeNull();
  });

  it("returns null for an empty / digitless message", () => {
    expect(extractSpokenPhone("")).toBeNull();
    expect(extractSpokenPhone("I don't have a phone")).toBeNull();
  });
});
