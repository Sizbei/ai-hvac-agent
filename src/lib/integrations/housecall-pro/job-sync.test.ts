import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import type { HousecallProClient } from "./client";
import type { HousecallJob } from "./types";

// ── Mock the HCP client factory ────────────────────────────────────────────
// getHousecallClient returns null when the org isn't connected; otherwise a
// fake client whose createJob/updateJob/cancelJob we control per test. The real
// HCP API (and the network) stay entirely out of the test.
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

// ── Mock the Stage-2 customer sync ──────────────────────────────────────────
// pushJobToHcp calls syncCustomerToHcp before creating a job. We stub it so the
// test controls whether the customer ends up mapped (by mutating the staged
// re-read row), without exercising the real customer-sync logic here.
const syncCustomerToHcp = vi.fn<() => Promise<void>>();
vi.mock("./customer-sync", () => ({
  syncCustomerToHcp: () => syncCustomerToHcp(),
}));

// ── Mock the DB ─────────────────────────────────────────────────────────────
// A SELECT chain (.from().leftJoin?().where()) shifts the next staged row set
// off `selectQueue`, so the create path's RE-READ returns a different snapshot
// than the first read (simulating the customer-sync write landing). update()
// .set().where() records what was written.
const dbState: {
  selectQueue: Record<string, unknown>[][];
  updateSet?: Record<string, unknown>;
} = { selectQueue: [] };

function makeWhere() {
  return () => Promise.resolve(dbState.selectQueue.shift() ?? []);
}

vi.mock("@/lib/db", () => {
  const select = vi.fn(() => {
    const where = makeWhere();
    const from = () => ({ leftJoin: () => ({ where }), where });
    return { from };
  });
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
vi.mock("@/lib/db/schema", () => ({ customers: {}, serviceRequests: {} }));

import { pushJobToHcp, cancelHcpJob } from "./job-sync";

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

/** Build a fake HCP client; track create/update/cancel calls for assertions. */
function fakeClient(overrides: Partial<HousecallProClient> = {}): {
  client: HousecallProClient;
  createJob: ReturnType<typeof vi.fn>;
  updateJob: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
} {
  const createJob = vi.fn();
  const updateJob = vi.fn();
  const cancelJob = vi.fn();
  const client = {
    createCustomer: vi.fn(),
    findCustomer: vi.fn(),
    createJob,
    updateJob,
    cancelJob,
    getJob: vi.fn(),
    listAvailability: vi.fn(),
    getAccountInfo: vi.fn(),
    ...overrides,
  } as unknown as HousecallProClient;
  return { client, createJob, updateJob, cancelJob };
}

function job(id: string): HousecallJob {
  return {
    id,
    customer_id: "hcp-cust-1",
    work_status: "scheduled",
    description: null,
    schedule_start: null,
    schedule_end: null,
  };
}

/** A request row as loadJobSyncRow's SELECT projects it (joined customer). */
function requestRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    requestId: "req-1",
    hcpJobId: null,
    customerId: "cust-1",
    hcpCustomerId: "hcp-cust-1",
    referenceNumber: "HVAC-ABCD1234",
    issueType: "No cooling",
    urgency: "high",
    description: "Warm air",
    arrivalWindowStart: new Date("2026-07-01T12:00:00.000Z"),
    arrivalWindowEnd: new Date("2026-07-01T16:00:00.000Z"),
    addressEncrypted: null,
    accessNotes: null,
    ...overrides,
  };
}

beforeEach(() => {
  getHousecallClient.mockReset();
  syncCustomerToHcp.mockReset().mockResolvedValue(undefined);
  dbState.selectQueue = [];
  dbState.updateSet = undefined;
});

describe("pushJobToHcp — not connected", () => {
  it("no-ops (no DB read, no network) when the org has no HCP client", async () => {
    getHousecallClient.mockResolvedValue(null);
    await pushJobToHcp("org-1", "req-1");
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("pushJobToHcp — create path", () => {
  it("ensures the customer is mapped, creates the job, and stores the id", async () => {
    const { client, createJob, updateJob } = fakeClient();
    createJob.mockResolvedValue(job("hcp-job-1"));
    getHousecallClient.mockResolvedValue(client);
    // First read: unmapped request. After syncCustomerToHcp, the re-read shows
    // the customer mapped (hcpCustomerId present) and still no job.
    dbState.selectQueue = [[requestRow()], [requestRow()]];

    await pushJobToHcp("org-1", "req-1");

    expect(syncCustomerToHcp).toHaveBeenCalledTimes(1);
    expect(updateJob).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledTimes(1);
    const arg = createJob.mock.calls[0][0];
    expect(arg.customerId).toBe("hcp-cust-1");
    expect(arg.requestId).toBe("req-1");
    expect(arg.scheduleStart).toBe("2026-07-01T12:00:00.000Z");
    expect(dbState.updateSet).toMatchObject({ hcpJobId: "hcp-job-1" });
  });

  it("creates an UNSCHEDULED job when the request has no arrival window", async () => {
    const { client, createJob } = fakeClient();
    createJob.mockResolvedValue(job("hcp-job-2"));
    getHousecallClient.mockResolvedValue(client);
    const unscheduled = requestRow({
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    });
    dbState.selectQueue = [[unscheduled], [unscheduled]];

    await pushJobToHcp("org-1", "req-1");

    const arg = createJob.mock.calls[0][0];
    expect(arg.scheduleStart).toBeUndefined();
    expect(arg.scheduleEnd).toBeUndefined();
    expect(dbState.updateSet).toMatchObject({ hcpJobId: "hcp-job-2" });
  });
});

describe("pushJobToHcp — idempotent update path", () => {
  it("UPDATEs the existing HCP job (no create) when hcp_job_id is set", async () => {
    const { client, createJob, updateJob } = fakeClient();
    updateJob.mockResolvedValue(job("hcp-job-1"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[requestRow({ hcpJobId: "hcp-job-1" })]];

    await pushJobToHcp("org-1", "req-1");

    expect(createJob).not.toHaveBeenCalled();
    expect(syncCustomerToHcp).not.toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob.mock.calls[0][0]).toBe("hcp-job-1");
    const fields = updateJob.mock.calls[0][1];
    expect(fields.scheduleStart).toBe("2026-07-01T12:00:00.000Z");
    // No mapping write — the row already carries a job id.
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("pushJobToHcp — no-op cases", () => {
  it("no-ops when the request row does not exist", async () => {
    const { client, createJob } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[]];
    await pushJobToHcp("org-1", "missing");
    expect(createJob).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });

  it("no-ops when the request has no customer to key a job to", async () => {
    const { client, createJob } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [
      [requestRow({ customerId: null, hcpCustomerId: null })],
    ];
    await pushJobToHcp("org-1", "req-1");
    expect(syncCustomerToHcp).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });

  it("skips creating a job when the customer still isn't mapped to HCP", async () => {
    const { client, createJob } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    // Both reads show the customer UNMAPPED (sync couldn't map it).
    const unmapped = requestRow({ hcpCustomerId: null });
    dbState.selectQueue = [[unmapped], [unmapped]];
    await pushJobToHcp("org-1", "req-1");
    expect(syncCustomerToHcp).toHaveBeenCalledTimes(1);
    expect(createJob).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });

  it("does not double-create when a concurrent push mapped the job between reads", async () => {
    const { client, createJob } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    // First read: unmapped. Re-read after sync: a racing push already set a job.
    dbState.selectQueue = [
      [requestRow()],
      [requestRow({ hcpJobId: "hcp-job-raced" })],
    ];
    await pushJobToHcp("org-1", "req-1");
    expect(createJob).not.toHaveBeenCalled();
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("pushJobToHcp — degrade-safe", () => {
  it("swallows an HCP create error and writes no mapping", async () => {
    const { client, createJob } = fakeClient();
    createJob.mockRejectedValue(new Error("HTTP 500"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[requestRow()], [requestRow()]];
    await expect(pushJobToHcp("org-1", "req-1")).resolves.toBeUndefined();
    expect(dbState.updateSet).toBeUndefined();
  });
});

describe("cancelHcpJob", () => {
  it("no-ops when the org has no HCP client", async () => {
    getHousecallClient.mockResolvedValue(null);
    await cancelHcpJob("org-1", "req-1");
  });

  it("no-ops when the request has no mapped HCP job", async () => {
    const { client, cancelJob } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[{ hcpJobId: null }]];
    await cancelHcpJob("org-1", "req-1");
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("cancels the mapped HCP job", async () => {
    const { client, cancelJob } = fakeClient();
    cancelJob.mockResolvedValue(undefined);
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[{ hcpJobId: "hcp-job-1" }]];
    await cancelHcpJob("org-1", "req-1");
    expect(cancelJob).toHaveBeenCalledWith("hcp-job-1");
  });

  it("swallows an HCP cancel error", async () => {
    const { client, cancelJob } = fakeClient();
    cancelJob.mockRejectedValue(new Error("HTTP 500"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectQueue = [[{ hcpJobId: "hcp-job-1" }]];
    await expect(cancelHcpJob("org-1", "req-1")).resolves.toBeUndefined();
  });
});
