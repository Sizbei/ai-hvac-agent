import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { decrypt } from "@/lib/crypto";

// In-memory capture of what the queries write/read, so we can assert the API
// key is ENCRYPTED at rest and never stored or returned in plaintext.
const captured: {
  insertValues?: Record<string, unknown>;
  selectRows: Record<string, unknown>[];
} = { selectRows: [] };

vi.mock("@/lib/db", () => {
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: () => {
        captured.insertValues = v;
        return Promise.resolve();
      },
    }),
  }));
  // select().from().where() resolves to the staged rows (a thenable chain).
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(captured.selectRows),
    }),
  }));
  const update = vi.fn(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }));
  return { db: { insert, select, update } };
});

vi.mock("@/lib/db/tenant", () => ({ withTenant: () => undefined }));
vi.mock("@/lib/db/schema", () => ({ housecallProConnections: {} }));

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

describe("saveHousecallConnection — encryption at rest", () => {
  it("stores the API key ENCRYPTED, never in plaintext, and round-trips", async () => {
    const { saveHousecallConnection } = await import("./connection-queries");
    await saveHousecallConnection("org-1", {
      apiKey: "super-secret-hcp-key",
      accountInfo: { companyName: "Acme HVAC", accountId: "acct-1" },
    });

    const values = captured.insertValues!;
    const stored = values.apiKeyEncrypted as string;
    expect(stored).not.toContain("super-secret-hcp-key");
    expect(decrypt(stored)).toBe("super-secret-hcp-key");
    expect(values.connected).toBe(true);
    expect(values.accountInfo).toEqual({
      companyName: "Acme HVAC",
      accountId: "acct-1",
    });
  });
});

describe("getOrgHousecallApiKey — decrypt on read", () => {
  it("returns null when no row exists", async () => {
    captured.selectRows = [];
    const { getOrgHousecallApiKey } = await import("./connection-queries");
    expect(await getOrgHousecallApiKey("org-1")).toBeNull();
  });

  it("returns null when connected=false", async () => {
    const { encrypt } = await import("@/lib/crypto");
    captured.selectRows = [
      { connected: false, apiKeyEncrypted: encrypt("k") },
    ];
    const { getOrgHousecallApiKey } = await import("./connection-queries");
    expect(await getOrgHousecallApiKey("org-1")).toBeNull();
  });

  it("decrypts the stored key when connected", async () => {
    const { encrypt } = await import("@/lib/crypto");
    captured.selectRows = [
      { connected: true, apiKeyEncrypted: encrypt("plain-key") },
    ];
    const { getOrgHousecallApiKey } = await import("./connection-queries");
    expect(await getOrgHousecallApiKey("org-1")).toBe("plain-key");
  });
});

describe("getHousecallConnectionStatus — key-free status", () => {
  it("reports DISCONNECTED when no row exists", async () => {
    captured.selectRows = [];
    const { getHousecallConnectionStatus } = await import(
      "./connection-queries"
    );
    expect(await getHousecallConnectionStatus("org-1")).toEqual({
      connected: false,
      accountInfo: null,
    });
  });

  it("reports connected + account info (and never a key) when connected", async () => {
    const { encrypt } = await import("@/lib/crypto");
    captured.selectRows = [
      {
        connected: true,
        apiKeyEncrypted: encrypt("k"),
        accountInfo: { companyName: "Acme HVAC", accountId: "acct-1" },
      },
    ];
    const { getHousecallConnectionStatus } = await import(
      "./connection-queries"
    );
    const status = await getHousecallConnectionStatus("org-1");
    expect(status.connected).toBe(true);
    expect(status.accountInfo).toEqual({
      companyName: "Acme HVAC",
      accountId: "acct-1",
    });
    // The status object exposes no key material at all.
    expect(JSON.stringify(status)).not.toContain("apiKey");
  });
});
