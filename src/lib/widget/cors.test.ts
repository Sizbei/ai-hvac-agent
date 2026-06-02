import { describe, it, expect } from "vitest";
import { corsHeaders } from "./cors";

describe("corsHeaders", () => {
  it("reflects the origin when the allowlist is empty (key-gated, open)", () => {
    const h = corsHeaders("https://acme.com", []);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://acme.com");
  });

  it("reflects the origin when it matches a non-empty allowlist", () => {
    const h = corsHeaders("https://app.acme.com", ["*.acme.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.acme.com");
  });

  it("does NOT set Allow-Origin when the origin is not allowlisted", () => {
    const h = corsHeaders("https://evil.com", ["https://acme.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("never uses a wildcard Allow-Origin", () => {
    const h = corsHeaders("https://acme.com", ["https://acme.com"]);
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("omits Allow-Origin for a missing origin but keeps base headers", () => {
    const h = corsHeaders(null, []);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Headers"]).toContain("X-HVAC-Widget-Key");
  });

  it("always advertises the widget-key header and Vary: Origin", () => {
    const h = corsHeaders("https://acme.com", []);
    expect(h["Access-Control-Allow-Headers"]).toContain("X-HVAC-Widget-Key");
    expect(h["Vary"]).toBe("Origin");
  });
});
