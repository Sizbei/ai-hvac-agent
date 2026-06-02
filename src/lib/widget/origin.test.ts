import { describe, it, expect } from "vitest";
import { originMatchesEntry, isOriginAllowed } from "./origin";

describe("originMatchesEntry", () => {
  it("matches an exact origin", () => {
    expect(
      originMatchesEntry("https://acme.com", "https://acme.com"),
    ).toBe(true);
  });

  it("is case-insensitive and ignores a trailing slash", () => {
    expect(
      originMatchesEntry("https://ACME.com/", "https://acme.com"),
    ).toBe(true);
  });

  it("does not match a different scheme for an exact origin entry", () => {
    expect(originMatchesEntry("http://acme.com", "https://acme.com")).toBe(
      false,
    );
  });

  it("matches any scheme for a bare-host entry", () => {
    expect(originMatchesEntry("http://acme.com", "acme.com")).toBe(true);
    expect(originMatchesEntry("https://acme.com", "acme.com")).toBe(true);
  });

  it("wildcard matches subdomains but NOT the apex", () => {
    expect(originMatchesEntry("https://app.acme.com", "*.acme.com")).toBe(true);
    expect(originMatchesEntry("https://a.b.acme.com", "*.acme.com")).toBe(true);
    expect(originMatchesEntry("https://acme.com", "*.acme.com")).toBe(false);
  });

  it("wildcard does not match a different domain", () => {
    expect(originMatchesEntry("https://acme.com.evil.com", "*.acme.com")).toBe(
      false,
    );
    expect(originMatchesEntry("https://evil.com", "*.acme.com")).toBe(false);
  });

  it("does not match a lookalike suffix without a dot boundary", () => {
    // "notacme.com" must not match "acme.com" bare host.
    expect(originMatchesEntry("https://notacme.com", "acme.com")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(originMatchesEntry("", "acme.com")).toBe(false);
    expect(originMatchesEntry("https://acme.com", "")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("is true when any entry matches", () => {
    expect(
      isOriginAllowed("https://app.acme.com", [
        "https://other.com",
        "*.acme.com",
      ]),
    ).toBe(true);
  });

  it("is false when no entry matches", () => {
    expect(isOriginAllowed("https://evil.com", ["acme.com"])).toBe(false);
  });

  it("is false for a null/missing origin", () => {
    expect(isOriginAllowed(null, ["acme.com"])).toBe(false);
    expect(isOriginAllowed(undefined, ["acme.com"])).toBe(false);
  });

  it("is false for an empty allowlist (caller decides open vs closed)", () => {
    expect(isOriginAllowed("https://acme.com", [])).toBe(false);
  });
});
