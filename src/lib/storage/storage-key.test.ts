import { describe, it, expect } from "vitest";
import { storageKeyFromPublicUrl } from "./storage-key";

const BASE = "https://pub.example.r2.dev";

describe("storageKeyFromPublicUrl", () => {
  it("strips the public URL prefix", () => {
    expect(storageKeyFromPublicUrl(`${BASE}/signatures/org/a.png`, BASE)).toBe("signatures/org/a.png");
  });

  it("tolerates trailing slashes on the configured public URL", () => {
    expect(storageKeyFromPublicUrl(`${BASE}/signatures/a.png`, `${BASE}/`)).toBe("signatures/a.png");
    expect(storageKeyFromPublicUrl(`${BASE}/signatures/a.png`, `${BASE}//`)).toBe("signatures/a.png");
  });

  it("returns null for a URL under a different prefix", () => {
    expect(storageKeyFromPublicUrl("https://other.example/signatures/a.png", BASE)).toBeNull();
    // A look-alike host that merely starts with the base string is not a match.
    expect(storageKeyFromPublicUrl(`${BASE}.evil.example/a.png`, BASE)).toBeNull();
  });

  it("returns null for a null URL", () => {
    expect(storageKeyFromPublicUrl(null, BASE)).toBeNull();
  });

  it("returns null when the public URL is unset", () => {
    expect(storageKeyFromPublicUrl(`${BASE}/a.png`, undefined)).toBeNull();
    expect(storageKeyFromPublicUrl(`${BASE}/a.png`, "")).toBeNull();
  });

  it("returns null when nothing follows the prefix", () => {
    expect(storageKeyFromPublicUrl(`${BASE}/`, BASE)).toBeNull();
  });

  it("defaults to R2_PUBLIC_URL from the environment", () => {
    const prev = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = BASE;
    try {
      expect(storageKeyFromPublicUrl(`${BASE}/k.png`)).toBe("k.png");
    } finally {
      if (prev === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = prev;
    }
  });
});
