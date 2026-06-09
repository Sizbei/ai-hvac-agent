import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTtsToken,
  verifyTtsToken,
  TTS_TOKEN_TTL_MS,
} from "./tts-token";

const KEY = "a".repeat(64); // 32 bytes hex
const NOW = 1_700_000_000_000;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});
afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("createTtsToken / verifyTtsToken", () => {
  it("round-trips a valid token within its window", () => {
    const token = createTtsToken("Hello caller.", NOW);
    expect(token.expiresAt).toBe(NOW + TTS_TOKEN_TTL_MS);
    expect(verifyTtsToken(token, NOW)).toBe("Hello caller.");
    // Still valid just before expiry.
    expect(verifyTtsToken(token, token.expiresAt)).toBe("Hello caller.");
  });

  it("rejects an expired token", () => {
    const token = createTtsToken("Hello.", NOW);
    expect(verifyTtsToken(token, token.expiresAt + 1)).toBeNull();
  });

  it("rejects a tampered text (signature no longer matches)", () => {
    const token = createTtsToken("Speak this.", NOW);
    expect(
      verifyTtsToken({ ...token, text: "Speak something else." }, NOW),
    ).toBeNull();
  });

  it("rejects a tampered expiry", () => {
    const token = createTtsToken("Speak this.", NOW);
    expect(
      verifyTtsToken({ ...token, expiresAt: token.expiresAt + 999 }, NOW),
    ).toBeNull();
  });

  it("rejects a forged signature", () => {
    const token = createTtsToken("Speak this.", NOW);
    expect(verifyTtsToken({ ...token, sig: "deadbeef" }, NOW)).toBeNull();
  });

  it("fails closed on malformed input", () => {
    expect(verifyTtsToken({}, NOW)).toBeNull();
    expect(verifyTtsToken({ text: "", expiresAt: NOW, sig: "x" }, NOW)).toBeNull();
    expect(
      verifyTtsToken({ text: "x", expiresAt: NaN, sig: "x" }, NOW),
    ).toBeNull();
  });

  it("is keyed — a different ENCRYPTION_KEY does not verify", () => {
    const token = createTtsToken("Speak this.", NOW);
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    try {
      expect(verifyTtsToken(token, NOW)).toBeNull();
    } finally {
      process.env.ENCRYPTION_KEY = KEY;
    }
  });
});
