import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { FieldpulseClient } from "./client";
import type { FieldpulseCustomer } from "./types";

// ── Mock the Fieldpulse client factory ─────────────────────────────────────
// getFieldpulseClient returns null when the org isn't connected; otherwise a
// fake client whose findCustomer/createCustomer we control per test. This
// keeps the real Fieldpulse API (and the network) entirely out of the test.
const getFieldpulseClient =
  vi.fn<
    (
      organizationId: string,
      fetchImpl?: typeof fetch,
    ) => Promise<FieldpulseClient | null>
  >();
vi.mock("./client", () => ({
  getFieldpulseClient: (organizationId: string, fetchImpl?: typeof fetch) =>
    getFieldpulseClient(organizationId, fetchImpl),
}));

// ── Mock the DB ──────────────────────────────────────────────────────────────
// select().from().where() resolves the staged customer row(s) on the FIRST
// call (the row lookup) and the staged claimant row(s) on every subsequent
// call (the adoption pre-check); update()...where() records what was written
// so we can assert the mapping is persisted (or, for the pre-check tests,
// that it was NOT).
const dbState: {
  selectRows: Record<string, unknown>[];
  claimedRows: Record<string, unknown>[];
  selectCallCount: number;
  updateSet?: Record<string, unknown>;
} = { selectRows: [], claimedRows: [], selectCallCount: 0 };

vi.mock("@/lib/db", () => {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        dbState.selectCallCount += 1;
        const rows =
          dbState.selectCallCount === 1
            ? dbState.selectRows
            : dbState.claimedRows;
        return Promise.resolve(rows);
      },
    }),
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

import { syncCustomerToFieldpulse, splitName } from "./customer-sync";
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

/** Build a fake Fieldpulse client; track create/find calls for assertions. */
function fakeClient(overrides: Partial<FieldpulseClient> = {}): {
  client: FieldpulseClient;
  createCustomer: ReturnType<typeof vi.fn>;
  findCustomer: ReturnType<typeof vi.fn>;
} {
  const createCustomer = vi.fn();
  const findCustomer = vi.fn();
  const client = {
    createCustomer,
    findCustomer,
    createJob: vi.fn(),
    updateJob: vi.fn(),
    cancelJob: vi.fn(),
    addJobNote: vi.fn(),
    listCustomerJobs: vi.fn(),
    getJob: vi.fn(),
    getJobRaw: vi.fn(),
    listUsers: vi.fn(),
    ...overrides,
  } as unknown as FieldpulseClient;
  return { client, createCustomer, findCustomer };
}

function fpCustomer(id: string): FieldpulseCustomer {
  return {
    id,
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "5551234567",
  };
}

beforeEach(() => {
  getFieldpulseClient.mockReset();
  dbState.selectRows = [];
  dbState.claimedRows = [];
  dbState.selectCallCount = 0;
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

describe("syncCustomerToFieldpulse — not connected", () => {
  it("no-ops (no DB read, no network) when the org has no Fieldpulse client", async () => {
    getFieldpulseClient.mockResolvedValue(null);
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("syncCustomerToFieldpulse — idempotency", () => {
  it("no-ops when the customer is already mapped to a Fieldpulse id", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: "fp-existing",
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(findCustomer).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
    // No mapping write — the row already carries an id.
    expect(dbState.updateSet).toBeUndefined();
  });

  it("no-ops when the customer row does not exist", async () => {
    const { client, createCustomer } = fakeClient();
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [];
    await syncCustomerToFieldpulse("org-1", "missing");
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("syncCustomerToFieldpulse — find vs create", () => {
  it("reuses an existing Fieldpulse customer (find hit) without creating", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(fpCustomer("fp-found"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: encrypt("5551234567"),
        addressEncrypted: null,
      },
    ];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ email: "jane@example.com" });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toMatchObject({ fieldpulseCustomerId: "fp-found" });
  });

  it("rejects a fuzzy (non-exact) find hit and creates instead", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    // Fieldpulse's fuzzy search returns a DIFFERENT contact (email/phone mismatch).
    findCustomer.mockResolvedValue({
      id: "fp-wrong",
      firstName: "Someone",
      lastName: "Else",
      email: "someone.else@example.com",
      phone: "5550000000",
    });
    createCustomer.mockResolvedValue(fpCustomer("fp-created-exact"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: encrypt("5551234567"),
        addressEncrypted: null,
      },
    ];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(findCustomer).toHaveBeenCalledWith({ email: "jane@example.com" });
    // The fuzzy hit is NOT reused — we create rather than mis-map.
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(dbState.updateSet).toMatchObject({
      fieldpulseCustomerId: "fp-created-exact",
    });
  });

  it("creates a new Fieldpulse customer when find returns null, and stores the id", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(null);
    createCustomer.mockResolvedValue(fpCustomer("fp-created"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(dbState.updateSet).toMatchObject({ fieldpulseCustomerId: "fp-created" });
  });

  it("skips the Fieldpulse find when the customer has neither email nor phone", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    createCustomer.mockResolvedValue(fpCustomer("fp-noid"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: null,
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(findCustomer).not.toHaveBeenCalled();
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(dbState.updateSet).toMatchObject({ fieldpulseCustomerId: "fp-noid" });
  });
});

describe("syncCustomerToFieldpulse — adoption pre-check", () => {
  it("skips adoption (issues no UPDATE) when the resolved Fieldpulse id is already claimed by another row", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(fpCustomer("fp-taken"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    // The pre-check SELECT finds a different native row already owns this id
    // (post-split, Fieldpulse's find-by-email increasingly resolves to an id
    // one of OUR OTHER rows already claimed).
    dbState.claimedRows = [{ id: "cust-other" }];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(createCustomer).not.toHaveBeenCalled();
    // The guarded UPDATE must never be attempted once the id is known-taken —
    // this is what stops the old "swallow the unique violation forever" loop.
    expect(dbState.updateSet).toBeUndefined();
  });

  it("proceeds with adoption when the resolved Fieldpulse id is not claimed by any other row", async () => {
    const { client, createCustomer, findCustomer } = fakeClient();
    findCustomer.mockResolvedValue(fpCustomer("fp-free"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    // The pre-check SELECT finds no claimant — the id is free to adopt.
    dbState.claimedRows = [];
    await syncCustomerToFieldpulse("org-1", "cust-1");
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbState.updateSet).toMatchObject({ fieldpulseCustomerId: "fp-free" });
  });
});

describe("syncCustomerToFieldpulse — degrade-safe", () => {
  it("swallows a Fieldpulse error and writes no mapping", async () => {
    const { client, findCustomer } = fakeClient();
    findCustomer.mockRejectedValue(new Error("HTTP 500"));
    getFieldpulseClient.mockResolvedValue(client);
    dbState.selectRows = [
      {
        id: "cust-1",
        fieldpulseCustomerId: null,
        nameEncrypted: encrypt("Jane Doe"),
        emailEncrypted: encrypt("jane@example.com"),
        phoneEncrypted: null,
        addressEncrypted: null,
      },
    ];
    // Must not throw — the booking flow depends on this never failing.
    await expect(
      syncCustomerToFieldpulse("org-1", "cust-1"),
    ).resolves.toBeUndefined();
    expect(dbState.updateSet).toBeUndefined();
  });
});
