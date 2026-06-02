import { describe, it, expect } from "vitest";
import {
  generateWidgetKey,
  hashApiKey,
  keyTypeFromValue,
  safeHashEqual,
  DEFAULT_SCOPES,
} from "./keys";

describe("widget key generation", () => {
  it("generates a publishable key with the pk_live_ prefix", () => {
    const k = generateWidgetKey("publishable");
    expect(k.plaintext.startsWith("pk_live_")).toBe(true);
    expect(k.keyType).toBe("publishable");
    expect(k.keyPrefix.startsWith("pk_live_")).toBe(true);
  });

  it("generates a secret key with the sk_live_ prefix", () => {
    const k = generateWidgetKey("secret");
    expect(k.plaintext.startsWith("sk_live_")).toBe(true);
  });

  it("stores a hash, not the plaintext", () => {
    const k = generateWidgetKey("publishable");
    expect(k.keyHash).not.toContain(k.plaintext);
    expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.keyHash).toBe(hashApiKey(k.plaintext));
  });

  it("is unique across generations", () => {
    const a = generateWidgetKey("publishable");
    const b = generateWidgetKey("publishable");
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    expect(hashApiKey("pk_live_x")).toBe(hashApiKey("pk_live_x"));
  });
  it("differs for different inputs", () => {
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });
});

describe("keyTypeFromValue", () => {
  it("identifies publishable / secret / unknown", () => {
    expect(keyTypeFromValue("pk_live_abc")).toBe("publishable");
    expect(keyTypeFromValue("sk_live_abc")).toBe("secret");
    expect(keyTypeFromValue("garbage")).toBeNull();
    expect(keyTypeFromValue("")).toBeNull();
  });
});

describe("default scopes", () => {
  it("publishable can only create/read sessions; secret is admin", () => {
    expect(DEFAULT_SCOPES.publishable).toEqual([
      "sessions:create",
      "sessions:read",
    ]);
    expect(DEFAULT_SCOPES.publishable).not.toContain("admin");
    expect(DEFAULT_SCOPES.secret).toEqual(["admin"]);
  });
});

describe("safeHashEqual", () => {
  it("returns true for identical hashes, false otherwise", () => {
    const h = hashApiKey("k");
    expect(safeHashEqual(h, h)).toBe(true);
    expect(safeHashEqual(h, hashApiKey("other"))).toBe(false);
  });
  it("returns false for different lengths without throwing", () => {
    expect(safeHashEqual("ab", "abcd")).toBe(false);
  });
});
