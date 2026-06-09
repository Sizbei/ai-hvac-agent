import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// In-memory rows the mocked select resolves to.
const dbState: { selectRows: Record<string, unknown>[] } = { selectRows: [] };

vi.mock("@/lib/db", () => {
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(dbState.selectRows) }),
  }));
  return { db: { select } };
});
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => undefined }));
vi.mock("@/lib/db/schema", () => ({ housecallProConnections: {} }));

const TEST_KEY = "a".repeat(64);
let savedKey: string | undefined;
let savedEnvSecret: string | undefined;

beforeAll(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  savedEnvSecret = process.env.HOUSECALL_WEBHOOK_SECRET;
  process.env.ENCRYPTION_KEY = TEST_KEY;
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  if (savedEnvSecret === undefined) delete process.env.HOUSECALL_WEBHOOK_SECRET;
  else process.env.HOUSECALL_WEBHOOK_SECRET = savedEnvSecret;
});

beforeEach(() => {
  dbState.selectRows = [];
  delete process.env.HOUSECALL_WEBHOOK_SECRET;
});

describe("getOrgWebhookSecret", () => {
  it("decrypts the per-org secret when connected", async () => {
    const { encrypt } = await import("@/lib/crypto");
    dbState.selectRows = [
      { connected: true, webhookSecretEncrypted: encrypt("whsec_org") },
    ];
    const { getOrgWebhookSecret } = await import("./webhook-secret-queries");
    expect(await getOrgWebhookSecret("org-1")).toBe("whsec_org");
  });

  it("falls back to the env secret when the org has no stored secret", async () => {
    process.env.HOUSECALL_WEBHOOK_SECRET = "whsec_env";
    dbState.selectRows = [{ connected: true, webhookSecretEncrypted: null }];
    const { getOrgWebhookSecret } = await import("./webhook-secret-queries");
    expect(await getOrgWebhookSecret("org-1")).toBe("whsec_env");
  });

  it("ignores a stored secret when the org is disconnected, using env fallback", async () => {
    const { encrypt } = await import("@/lib/crypto");
    process.env.HOUSECALL_WEBHOOK_SECRET = "whsec_env";
    dbState.selectRows = [
      { connected: false, webhookSecretEncrypted: encrypt("whsec_org") },
    ];
    const { getOrgWebhookSecret } = await import("./webhook-secret-queries");
    expect(await getOrgWebhookSecret("org-1")).toBe("whsec_env");
  });

  it("returns null when neither a stored nor an env secret is configured", async () => {
    dbState.selectRows = [];
    const { getOrgWebhookSecret } = await import("./webhook-secret-queries");
    expect(await getOrgWebhookSecret("org-1")).toBeNull();
  });
});
