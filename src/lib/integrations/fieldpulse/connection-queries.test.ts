/**
 * Tests for `getFieldpulseConnectionStatus`'s Rintegrations-2 shape: it must
 * surface `availabilitySyncStatus`/`lastAvailabilitySyncAt`/`lastSyncError`
 * alongside `connected`/`accountInfo`, and must never leak a key-shaped field
 * — mirrors the secrecy contract asserted in `integrations-status.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFieldpulseConnectionStatus } from "./connection-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

function mockRow(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

describe("getFieldpulseConnectionStatus", () => {
  it("returns the disconnected shape (all sync fields null) when no row exists", async () => {
    mockRow([]);
    const status = await getFieldpulseConnectionStatus("org-1");
    expect(status.connected).toBe(false);
    expect(status.availabilitySyncStatus).toBeNull();
    expect(status.lastAvailabilitySyncAt).toBeNull();
    expect(status.lastSyncError).toBeNull();
  });

  it("surfaces availabilitySyncStatus/lastAvailabilitySyncAt/lastSyncError when connected", async () => {
    mockRow([
      {
        connected: true,
        apiKeyEncrypted: "cipher-text",
        accountInfo: { companyName: "Acme HVAC", accountId: "acct_1" },
        availabilitySyncStatus: "failed",
        lastAvailabilitySyncAt: new Date("2026-08-10T12:00:00.000Z"),
        lastSyncError: "401 Unauthorized",
      },
    ]);
    const status = await getFieldpulseConnectionStatus("org-1");
    expect(status.connected).toBe(true);
    expect(status.availabilitySyncStatus).toBe("failed");
    expect(status.lastAvailabilitySyncAt).toBe("2026-08-10T12:00:00.000Z");
    expect(status.lastSyncError).toBe("401 Unauthorized");
  });

  it("never returns a key-shaped field name or the encrypted key value (secrecy contract)", async () => {
    mockRow([
      {
        connected: true,
        apiKeyEncrypted: "SECRET_cipher_value",
        accountInfo: null,
        availabilitySyncStatus: "completed",
        lastAvailabilitySyncAt: null,
        lastSyncError: null,
      },
    ]);
    const status = await getFieldpulseConnectionStatus("org-1");

    for (const key of Object.keys(status)) {
      expect(key).not.toMatch(/apiKey|Encrypted|token|secret/i);
    }
    expect(JSON.stringify(status)).not.toContain("SECRET_cipher_value");
  });

  it("returns disconnected when the row exists but has no encrypted key", async () => {
    mockRow([
      {
        connected: true,
        apiKeyEncrypted: null,
        accountInfo: null,
        availabilitySyncStatus: "failed",
        lastAvailabilitySyncAt: null,
        lastSyncError: "stale",
      },
    ]);
    const status = await getFieldpulseConnectionStatus("org-1");
    expect(status.connected).toBe(false);
    expect(status.availabilitySyncStatus).toBeNull();
  });
});
