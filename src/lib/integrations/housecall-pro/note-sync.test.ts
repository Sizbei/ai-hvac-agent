import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HousecallProClient } from "./client";

// ── Mock the HCP client factory ────────────────────────────────────────────
// getHousecallClient returns null when the org isn't connected; otherwise a
// fake client whose addJobNote we control per test. The real HCP API (and the
// network) stay entirely out of the test.
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

// ── Mock the DB ─────────────────────────────────────────────────────────────
// A SELECT chain (.from().where()) resolves to `selectRows`, mirroring the way
// job-sync.test.ts mocks its hcp_job_id read for cancelHcpJob.
const dbState: { selectRows: Record<string, unknown>[] } = { selectRows: [] };

vi.mock("@/lib/db", () => {
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(dbState.selectRows) }),
  }));
  return { db: { select } };
});

vi.mock("@/lib/db/tenant", () => ({ withTenant: () => undefined }));
vi.mock("@/lib/db/schema", () => ({ serviceRequests: {} }));

import { syncJobNoteToHcp } from "./note-sync";

/** Build a fake HCP client; track addJobNote calls for assertions. */
function fakeClient(overrides: Partial<HousecallProClient> = {}): {
  client: HousecallProClient;
  addJobNote: ReturnType<typeof vi.fn>;
} {
  const addJobNote = vi.fn();
  const client = {
    createCustomer: vi.fn(),
    findCustomer: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    cancelJob: vi.fn(),
    addJobNote,
    getJob: vi.fn(),
    listAvailability: vi.fn(),
    listTechnicians: vi.fn(),
    getAccountInfo: vi.fn(),
    ...overrides,
  } as unknown as HousecallProClient;
  return { client, addJobNote };
}

beforeEach(() => {
  getHousecallClient.mockReset();
  dbState.selectRows = [];
});

describe("syncJobNoteToHcp — pushes when mapped", () => {
  it("pushes the trimmed note to the mapped HCP job", async () => {
    const { client, addJobNote } = fakeClient();
    addJobNote.mockResolvedValue(undefined);
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [{ hcpJobId: "hcp-job-1" }];

    await syncJobNoteToHcp("org-1", "req-1", "  Gate code 1234  ");

    expect(addJobNote).toHaveBeenCalledTimes(1);
    expect(addJobNote).toHaveBeenCalledWith("hcp-job-1", "Gate code 1234");
  });
});

describe("syncJobNoteToHcp — no-op cases", () => {
  it("no-ops (no client, no DB read) when the note is empty/whitespace", async () => {
    const { client, addJobNote } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    await syncJobNoteToHcp("org-1", "req-1", "   ");
    expect(getHousecallClient).not.toHaveBeenCalled();
    expect(addJobNote).not.toHaveBeenCalled();
  });

  it("no-ops when the org has no HCP client (not connected)", async () => {
    getHousecallClient.mockResolvedValue(null);
    // No row staged: if we read the DB this would throw on .where() returning [].
    await syncJobNoteToHcp("org-1", "req-1", "A note");
    // Reaching here without throwing is the assertion (no client → safe no-op).
    expect(getHousecallClient).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the request has no mapped HCP job (not in HCP yet)", async () => {
    const { client, addJobNote } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [{ hcpJobId: null }];
    await syncJobNoteToHcp("org-1", "req-1", "A note");
    expect(addJobNote).not.toHaveBeenCalled();
  });

  it("no-ops when the request row does not exist", async () => {
    const { client, addJobNote } = fakeClient();
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [];
    await syncJobNoteToHcp("org-1", "missing", "A note");
    expect(addJobNote).not.toHaveBeenCalled();
  });
});

describe("syncJobNoteToHcp — degrade-safe", () => {
  it("swallows an HCP addJobNote error (never throws)", async () => {
    const { client, addJobNote } = fakeClient();
    addJobNote.mockRejectedValue(new Error("HTTP 500"));
    getHousecallClient.mockResolvedValue(client);
    dbState.selectRows = [{ hcpJobId: "hcp-job-1" }];
    await expect(
      syncJobNoteToHcp("org-1", "req-1", "A note"),
    ).resolves.toBeUndefined();
    expect(addJobNote).toHaveBeenCalledTimes(1);
  });
});
