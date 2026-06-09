import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { decrypt } from "@/lib/crypto";

// In-memory capture of what the queries write, so we can assert the refresh
// token is ENCRYPTED at rest and never stored or returned in plaintext.
const captured: { insertValues?: Record<string, unknown> } = {};

vi.mock("@/lib/db", () => {
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: () => {
        captured.insertValues = v;
        return Promise.resolve();
      },
    }),
  }));
  return { db: { insert } };
});

const TEST_KEY = "a".repeat(64);
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
});
afterAll(() => {
  if (savedKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = savedKey;
  }
});

describe("saveGoogleConnection — encryption at rest", () => {
  it("stores the refresh token ENCRYPTED, never in plaintext", async () => {
    const { saveGoogleConnection } = await import("./connection-queries");
    await saveGoogleConnection("org-1", {
      refreshToken: "super-secret-refresh",
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 3600_000,
      calendarId: "primary",
    });

    const values = captured.insertValues!;
    const stored = values.refreshTokenEncrypted as string;
    // The ciphertext is not the plaintext...
    expect(stored).not.toContain("super-secret-refresh");
    // ...and it round-trips back to the original via decrypt.
    expect(decrypt(stored)).toBe("super-secret-refresh");
    expect(values.connected).toBe(true);
    expect(values.calendarId).toBe("primary");
  });
});
