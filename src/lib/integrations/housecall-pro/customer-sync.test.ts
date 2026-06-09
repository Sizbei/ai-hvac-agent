import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { HousecallProClient } from "./client";
import type { HousecallCustomer } from "./types";

// ── Mock the HCP client factory ────────────────────────────────────────────
// getHousecallClient returns null when the org isn't connected; otherwise a
// fake client whose findCustomer/createCustomer we control per test. This keeps
// the real HCP API (and the network) entirely out of the test.
const getHousecallClient =
  vi.fn<
    (
      organizationId: string,
      fetchImpl?: typeof fetch,
    ) => Promise<HousecallProClient | null>
  >();
vi.mock("./client", () => ({
  getHousecallClient: (organizationId: string, fetchImpl?: typeof fetch) =>
    getHousecallClient(organizationId, fetchImpl),
}));

// ── Mock the DB ──────────────────────────────────────────────────────────────
// select().from().where() resolves the staged customer row(s); update()...where()
// records what was written so we can assert the mapping is persisted.
const dbState: {
  selectRows: Record<string, unknown>[];
  updateSet?: Record<string, unknown>;
} = { selectRows: [] };

vi.mock("@/lib/db", () => {
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(dbState.selectRows) }),
  }));
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => ({
      where: () => {
        dbState.updateSet = v;
        return Promise.resolve();
      },
    }),
  }));
  return { db: { select, update } };
});

vi.mock("@/lib/db/tenant", () => ({ withTenant: () => undefined }));
vi.mock("@/lib/db/schema", () => ({ customers: {} }));

import { syncCustomerToHcp, splitName } from "./customer-sync";
import { encrypt } from "@/lib/crypto";

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

/** Build a fake HCP client; track create/find calls for assertions. */
function fakeClient(overrides: Partial<HousecallProClient> = {}): {
  client: HousecallProClient;
  createCustomer: ReturnType<typeof vi.fn>;
  findCustomer: ReturnType<typeof vi.fn>;
} {
  const createCustomer = vi.fn();
  const findCustomer = vi.fn();
  const client = {
    createCustomer,
    findCustomer,
    createJob: vi.fn(),
    getJob: vi.fn(),
    listAvailability: vi.fn(),
    getAccountInfo: vi.fn(),
    ...overrides,
  } as unknown as HousecallProClient;
  return { client, createCustomer, findCustomer };
}

function hcpCustomer(id: string): HousecallCustomer {
  return {
    id,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@example.com",
    mobile_number: "5551234567",
    home_number: null,
    company: null,
    addresses: [],
  };
}

beforeEach(() => {
  getHousecallClient.mockReset();
  dbState.selectRows = [];
  dbState.updateSet = undefined;
});

describe("splitName", () => {
  it("splits a full name into first + last", () => {
    expect(splitName("Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });
  it("keeps a middle name on the first-name side", () => {
    expect(splitName("Jane Q Public")).toEqual({
      firstName: "Jane Q",
      lastName: "Public",
    });
  });
  it("uses a placeholder last name for a single-token name", () => {
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "Customer" });
  });
  it("uses placeholders for an empty/null name", () => {
    expect(splitName(null)).toEqual({ firstName: "Unknown", lastName: "Customer" });
    expect(splitName("   ")).toEqual({ firstName: "Unknown", lastName: "Customer" });
  });
});

describe("syncCustomerToHcp — not connected", () => {
  it("no-ops (no DB read, no network) when the org has no HCP client", async () => {
    getHousecallClient.mockResolvedValue(null);
    await syncCustomerToHcp("org-1", "cust-1");
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("syncCustomerToHcp — idempotency", () => {
  it("no-ops when the customer is already mapped to an HCP id", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: "hcp-existing",
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
    // No mapping write — the row already carries an id.
    expect(dbState.updateSet).toBeUndefined();
  });

  it("no-ops when the customer row does not exist", async () => {
    const { client, createCustomer } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [];
    await syncCustomerToHcp("org-1", "missing");
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("syncCustomerToHcp — find vs create", () => {
  it("reuses an existing HCP customer (find hit) without creating", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(hcpCustomer("hcp-found"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: encrypt("5551234567"),
        addressEncrypted: encrypt("1 Main St"),
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ email: "jane@example.com" });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-found" });
  });

  it("rejects a fuzzy (non-exact) find hit and creates instead", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    // HCP's fuzzy q-search returns a DIFFERENT contact (email/phone mismatch).
    findCustomer.mockResolvedValue({
      id: "hcp-wrong",
      first_name: "Someone",
      last_name: "Else",
      email: "someone.else@example.com",
      mobile_number: "5550000000",
      home_number: null,
      company: null,
      addresses: [],
    });
    createCustomer.mockResolvedValue(hcpCustomer("hcp-created-exact"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: encrypt("5551234567"),
        addressEncrypted: null,
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ email: "jane@example.com" });
    // The fuzzy hit is NOT reused — we create rather than mis-map.
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-created-exact" });
  });

  it("reuses a find hit that matches on phone (digits-only, ignoring formatting)", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue({
      id: "hcp-phone-match",
      first_name: "Cher",
      last_name: "Customer",
      email: null,
      mobile_number: "(555) 999-8888",
      home_number: null,
      company: null,
      addresses: [],
    });
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Cher"),
        emailEncrypted: null,
        phoneEncrypted: encrypt("5559998888"),
        addressEncrypted: null,
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ phone: "5559998888" });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-phone-match" });
  });

  it("creates a new HCP customer when find returns null, and stores the id", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(null);
    createCustomer.mockResolvedValue(hcpCustomer("hcp-created"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: encrypt("1 Main St"),
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(createCustomer).toHaveBeenCalledWith({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      mobileNumber: undefined,
      address: { street: "1 Main St" },
    });
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-created" });
  });

  it("falls back to a phone lookup when no email is present", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(null);
    createCustomer.mockResolvedValue(hcpCustomer("hcp-phone"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Cher"),
        emailEncrypted: null,
        phoneEncrypted: encrypt("5559998888"),
        addressEncrypted: null,
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ phone: "5559998888" });
    expect(createCustomer).toHaveBeenCalledWith({
      firstName: "Cher",
      lastName: "Customer",
      email: undefined,
      mobileNumber: "5559998888",
      address: undefined,
    });
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-phone" });
  });

  it("skips the HCP find when the customer has neither email nor phone", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    createCustomer.mockResolvedValue(hcpCustomer("hcp-noid"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: null,
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    await syncCustomerToHcp("org-1", "cust-1");
    expect(findCustomer).not.toHaveBeenCalled();
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(dbState.updateSet).toMatchObject({ hcpCustomerId: "hcp-noid" });
  });
});

describe("syncCustomerToHcp — degrade-safe", () => {
  it("swallows an HCP error and writes no mapping", async () => {
    const { client, findCustomer } = fakeClient();
    findCustomer.mockRejectedValue(new Error("HTTP 500"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        hcpCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    // Must not throw — the booking flow depends on this never failing.
    await expect(syncCustomerToHcp("org-1", "cust-1")).resolves.toBeUndefined();
    expect(dbState.updateSet).toBeUndefined();
  });
});
