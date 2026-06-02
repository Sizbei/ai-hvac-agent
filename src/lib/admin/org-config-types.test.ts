import { describe, it, expect } from "vitest";
import { orgConfigUpdateSchema } from "./org-config-types";

describe("orgConfigUpdateSchema — URL safety", () => {
  it("accepts an https logo URL", () => {
    const r = orgConfigUpdateSchema.safeParse({
      logoUrl: "https://acme.com/logo.png",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a javascript: logo URL (XSS vector)", () => {
    const r = orgConfigUpdateSchema.safeParse({
      logoUrl: "javascript:alert(1)",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an http: logo URL", () => {
    const r = orgConfigUpdateSchema.safeParse({
      logoUrl: "http://acme.com/logo.png",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a data: logo URL", () => {
    const r = orgConfigUpdateSchema.safeParse({
      logoUrl: "data:text/html,<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-https website in businessInfo", () => {
    const r = orgConfigUpdateSchema.safeParse({
      businessInfo: { website: "javascript:alert(1)" },
    });
    expect(r.success).toBe(false);
  });
});
