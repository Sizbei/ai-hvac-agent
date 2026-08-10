import { describe, it, expect } from "vitest";
import { maskTokenPath } from "./analytics-path";

const TOKEN = "3f9a2b7c8d1e4f5a6b7c8d9e0f1a2b3c";

describe("maskTokenPath", () => {
  it.each(["portal", "estimates", "review"])(
    "masks the token segment on /%s/<token>",
    (prefix) => {
      const masked = maskTokenPath(`/${prefix}/${TOKEN}`);
      expect(masked).toBe(`/${prefix}/[token]`);
      expect(masked).not.toContain(TOKEN);
    },
  );

  it("masks the token in a full URL and keeps the origin", () => {
    expect(maskTokenPath(`https://example.com/portal/${TOKEN}`)).toBe(
      "https://example.com/portal/[token]",
    );
  });

  it("drops the query string, which could also carry the token", () => {
    expect(maskTokenPath(`/portal/${TOKEN}?ref=${TOKEN}`)).toBe("/portal/[token]");
  });

  it("drops the hash", () => {
    expect(maskTokenPath(`/review/${TOKEN}#thanks`)).toBe("/review/[token]");
  });

  it("truncates a nested path below the token segment", () => {
    expect(maskTokenPath(`/portal/${TOKEN}/invoices/abc`)).toBe("/portal/[token]");
  });

  it("leaves ordinary paths byte-identical", () => {
    for (const path of [
      "/",
      "/admin/invoices",
      "/admin/estimates/9a1f",
      "/chat",
      "https://example.com/admin/customers?page=2",
    ]) {
      expect(maskTokenPath(path)).toBe(path);
    }
  });

  it("leaves a token route with no token segment alone", () => {
    expect(maskTokenPath("/portal")).toBe("/portal");
    expect(maskTokenPath("/portal/")).toBe("/portal/");
  });

  it("handles empty input without throwing", () => {
    expect(maskTokenPath("")).toBe("");
  });
});
