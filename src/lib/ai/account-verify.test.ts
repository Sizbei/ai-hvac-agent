import { describe, it, expect } from "vitest";
import { requiresVerify, extractZipsFromAddress, checkZipMatch } from "./account-verify";

describe("requiresVerify", () => {
  it("gates financial intents only", () => {
    expect(requiresVerify("account-data-balance")).toBe(true);
    expect(requiresVerify("account-data-membership-status")).toBe(true);
    expect(requiresVerify("account-data-next-visit")).toBe(false);
    expect(requiresVerify("account-data-appointment-status")).toBe(false);
    expect(requiresVerify(null)).toBe(false);
  });
});

describe("extractZipsFromAddress", () => {
  it("pulls a 5-digit ZIP from a US address", () => {
    expect(extractZipsFromAddress("212 E Unaka Ave, Johnson City, TN 37601")).toEqual(["37601"]);
  });
  it("returns [] when no 5-digit ZIP is present (non-US / missing)", () => {
    expect(extractZipsFromAddress("12 King St, Toronto, ON K1A 0B1")).toEqual([]);
  });
});

describe("checkZipMatch", () => {
  it("matches DTMF digits against any on-file ZIP", () => {
    expect(checkZipMatch("37601", ["37601", "37615"])).toBe(true);
  });
  it("matches a spoken ZIP with 'oh' for zero", () => {
    expect(checkZipMatch("three seven six oh one", ["37601"])).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(checkZipMatch("00000", ["37601"])).toBe(false);
  });
});
