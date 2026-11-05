import { describe, it, expect } from "vitest";
import {
  customerMatchesSearch,
  phoneQueryDigits,
  CustomerScanCache,
} from "./customer-search";

const stored = {
  name: "Dana Halvorsen",
  email: "dana@example.com",
  phone: "(423) 555-0187",
  address: "12 Oak St, Johnson City, TN 37601",
};

describe("phoneQueryDigits", () => {
  it("returns digits for phone-shaped input", () => {
    expect(phoneQueryDigits("(423) 555-0187")).toBe("4235550187");
    expect(phoneQueryDigits("+1 423.555.0187")).toBe("14235550187");
  });
  it("returns null for text or too few digits", () => {
    expect(phoneQueryDigits("smith")).toBeNull();
    expect(phoneQueryDigits("12 Oak")).toBeNull();
    expect(phoneQueryDigits("42")).toBeNull();
  });
});

describe("customerMatchesSearch", () => {
  it.each([
    "(423) 555-0187",
    "423-555-0187",
    "4235550187",
    "423 555 0187",
    "423.555.0187",
    "555-0187",
    "1-423-555-0187",
    "+1 (423) 555-0187",
  ])("matches the stored phone typed as %s", (q) => {
    expect(customerMatchesSearch(stored, q)).toBe(true);
  });

  it("matches a number stored with the country code", () => {
    const withCc = { ...stored, phone: "+1 (423) 555-0187" };
    expect(customerMatchesSearch(withCc, "4235550187")).toBe(true);
    expect(customerMatchesSearch(withCc, "423-555-0187")).toBe(true);
  });

  it("does not match a different number", () => {
    expect(customerMatchesSearch(stored, "423-555-0188")).toBe(false);
  });

  it("matches name, email and address case-insensitively", () => {
    expect(customerMatchesSearch(stored, "HALVOR")).toBe(true);
    expect(customerMatchesSearch(stored, "dana@ex")).toBe(true);
    expect(customerMatchesSearch(stored, "oak st")).toBe(true);
    expect(customerMatchesSearch(stored, "zzzzqqq")).toBe(false);
  });

  it("handles missing fields and an empty query", () => {
    const empty = { name: null, email: null, phone: null, address: null };
    expect(customerMatchesSearch(empty, "423")).toBe(false);
    expect(customerMatchesSearch(empty, "  ")).toBe(true);
  });
});

describe("CustomerScanCache", () => {
  it("serves rows only for a matching fingerprint", () => {
    const cache = new CustomerScanCache<number>();
    cache.set("org", "fp1", [1, 2], 0);
    expect(cache.get("org", "fp1", 10)).toEqual([1, 2]);
    expect(cache.get("org", "fp2", 10)).toBeNull();
    // The stale entry was dropped.
    expect(cache.get("org", "fp1", 10)).toBeNull();
  });

  it("expires entries after the TTL", () => {
    const cache = new CustomerScanCache<number>(100);
    cache.set("org", "fp", [1], 0);
    expect(cache.get("org", "fp", 100)).toEqual([1]);
    expect(cache.get("org", "fp", 201)).toBeNull();
  });

  it("evicts the least recently used entry past the cap", () => {
    const cache = new CustomerScanCache<number>(1000, 2);
    cache.set("a", "f", [1], 0);
    cache.set("b", "f", [2], 0);
    cache.get("a", "f", 1); // a is now most recent
    cache.set("c", "f", [3], 2);
    expect(cache.size).toBe(2);
    expect(cache.get("b", "f", 3)).toBeNull();
    expect(cache.get("a", "f", 3)).toEqual([1]);
    expect(cache.get("c", "f", 3)).toEqual([3]);
  });
});
