import { describe, it, expect, vi, beforeEach } from "vitest";

// The factory dynamically imports the HCP client + HCP scheduling source. Mock
// both so selection is exercised without a real DB or HCP call.
const getHousecallClient = vi.fn<
  (organizationId: string) => Promise<unknown | null>
>();
vi.mock("@/lib/integrations/housecall-pro/client", () => ({
  getHousecallClient: (organizationId: string) =>
    getHousecallClient(organizationId),
}));

class FakeHcpSchedulingSource {
  constructor(
    public readonly organizationId: string,
    public readonly client: unknown,
  ) {}
}
vi.mock("@/lib/integrations/housecall-pro/scheduling-source", () => ({
  HcpSchedulingSource: FakeHcpSchedulingSource,
}));

// The DB source's constructor must not touch the DB; these mocks keep importing
// the module side-effect-free. The DB source class itself needs no DB to be
// constructed (its methods do, but the factory never calls them).
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ users: {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => ({}) }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("./scheduling-queries", () => ({
  getTechnicianAvailability: vi.fn(),
  getScheduledJobsForRange: vi.fn(),
}));

import {
  getSchedulingSource,
  DbSchedulingSource,
} from "./scheduling-source";

const ORG = "org-1";

beforeEach(() => {
  getHousecallClient.mockReset();
});

describe("getSchedulingSource — source selection", () => {
  it("returns the HCP source when the org is HCP-connected", async () => {
    const fakeClient = { listAvailability: vi.fn() };
    getHousecallClient.mockResolvedValue(fakeClient);

    const source = await getSchedulingSource(ORG);
    expect(source).toBeInstanceOf(FakeHcpSchedulingSource);
    expect((source as unknown as FakeHcpSchedulingSource).organizationId).toBe(
      ORG,
    );
    expect((source as unknown as FakeHcpSchedulingSource).client).toBe(
      fakeClient,
    );
  });

  it("returns the DB source when the org is NOT HCP-connected", async () => {
    getHousecallClient.mockResolvedValue(null);
    const source = await getSchedulingSource(ORG);
    expect(source).toBeInstanceOf(DbSchedulingSource);
  });

  it("falls back to the DB source when resolving the HCP client throws", async () => {
    getHousecallClient.mockRejectedValue(new Error("connection probe failed"));
    const source = await getSchedulingSource(ORG);
    expect(source).toBeInstanceOf(DbSchedulingSource);
  });
});
