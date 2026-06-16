/**
 * Tests for the webhook security primitives added in the hardening pass:
 * - isReplayTimestamp: replay/stale-event rejection (tolerant of absent/odd ts)
 * - getFieldpulseWebhookSecret: per-org secret resolution with env fallback
 *
 * These are the security-critical pure/near-pure functions the webhook routes
 * depend on; the route handlers themselves are integration-tested under a DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isReplayTimestamp } from "./webhook-signature";
import { getFieldpulseWebhookSecret, getFieldpulseWebhookSecretEnv } from "./config";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn() }));

const NOW = 1_900_000_000_000; // fixed "now" in ms
const now = () => NOW;

describe("isReplayTimestamp", () => {
  it("tolerates absent/null/empty timestamps (relies on idempotency ledger)", () => {
    expect(isReplayTimestamp(undefined, 300_000, now)).toBe(false);
    expect(isReplayTimestamp(null, 300_000, now)).toBe(false);
    expect(isReplayTimestamp("", 300_000, now)).toBe(false);
  });

  it("accepts a fresh epoch-ms timestamp", () => {
    expect(isReplayTimestamp(NOW - 60_000, 300_000, now)).toBe(false);
  });

  it("rejects a stale epoch-ms timestamp (older than the window)", () => {
    expect(isReplayTimestamp(NOW - 600_000, 300_000, now)).toBe(true);
  });

  it("rejects a far-future timestamp (clock skew / forged)", () => {
    expect(isReplayTimestamp(NOW + 600_000, 300_000, now)).toBe(true);
  });

  it("accepts a fresh epoch-SECONDS timestamp (heuristic conversion)", () => {
    expect(isReplayTimestamp(Math.floor(NOW / 1000) - 30, 300_000, now)).toBe(false);
  });

  it("accepts a fresh ISO timestamp and rejects a stale one", () => {
    const fresh = new Date(NOW - 10_000).toISOString();
    const stale = new Date(NOW - 3_600_000).toISOString();
    expect(isReplayTimestamp(fresh, 300_000, now)).toBe(false);
    expect(isReplayTimestamp(stale, 300_000, now)).toBe(true);
  });

  it("tolerates an unparseable timestamp string (does not reject)", () => {
    expect(isReplayTimestamp("not-a-timestamp", 300_000, now)).toBe(false);
  });
});

describe("getFieldpulseWebhookSecret", () => {
  const ORG = "org-1";
  const ENV_KEY = "FIELDPULSE_WEBHOOK_SECRET";
  let prevEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEnv = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  function mockSelect(rows: Array<{ webhookSecretEncrypted: string | null }>) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as never);
  }

  it("returns the org's own decrypted secret when present", async () => {
    delete process.env[ENV_KEY];
    mockSelect([{ webhookSecretEncrypted: "cipher" }]);
    vi.mocked(decrypt).mockReturnValue("per-org-secret");

    await expect(getFieldpulseWebhookSecret(ORG)).resolves.toBe("per-org-secret");
    expect(decrypt).toHaveBeenCalledWith("cipher");
  });

  it("falls back to the env secret when the org has none", async () => {
    process.env[ENV_KEY] = "  env-secret  ";
    mockSelect([{ webhookSecretEncrypted: null }]);

    await expect(getFieldpulseWebhookSecret(ORG)).resolves.toBe("env-secret");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("falls back to env when decrypt throws on tampered ciphertext", async () => {
    process.env[ENV_KEY] = "env-secret";
    mockSelect([{ webhookSecretEncrypted: "garbage" }]);
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("bad ciphertext");
    });

    await expect(getFieldpulseWebhookSecret(ORG)).resolves.toBe("env-secret");
  });

  it("returns null when neither per-org nor env secret is configured", async () => {
    delete process.env[ENV_KEY];
    mockSelect([]);
    await expect(getFieldpulseWebhookSecret(ORG)).resolves.toBeNull();
  });

  it("getFieldpulseWebhookSecretEnv trims and nulls empty", () => {
    process.env[ENV_KEY] = "   ";
    expect(getFieldpulseWebhookSecretEnv()).toBeNull();
    process.env[ENV_KEY] = " abc ";
    expect(getFieldpulseWebhookSecretEnv()).toBe("abc");
  });
});
