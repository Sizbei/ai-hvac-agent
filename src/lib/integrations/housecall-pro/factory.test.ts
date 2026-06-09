import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock connection storage so the factory never reads the DB. The factory must
// short-circuit to null when there's no key — without making any HTTP request.
const getOrgHousecallApiKey = vi.fn<
  (organizationId: string) => Promise<string | null>
>();
vi.mock("./connection-queries", () => ({
  getOrgHousecallApiKey: (organizationId: string) =>
    getOrgHousecallApiKey(organizationId),
}));

import { getHousecallClient, RestHousecallProClient } from "./client";

const savedEnv = { ...process.env };
/** A fetch that fails the test if the factory ever calls the network. */
const explodingFetch = (() => {
  throw new Error("fetch must not be called by the factory");
}) as unknown as typeof fetch;

beforeEach(() => {
  getOrgHousecallApiKey.mockReset();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("getHousecallClient — not configured", () => {
  it("returns null when no connection and no env fallback (no network)", async () => {
    delete process.env.HOUSECALL_API_KEY;
    getOrgHousecallApiKey.mockResolvedValue(null);
    const client = await getHousecallClient("org-1", explodingFetch);
    expect(client).toBeNull();
  });
});

describe("getHousecallClient — configured", () => {
  it("returns a RestHousecallProClient when the org has a stored key", async () => {
    delete process.env.HOUSECALL_API_KEY;
    getOrgHousecallApiKey.mockResolvedValue("org-key");
    const client = await getHousecallClient(
      "org-1",
      explodingFetch,
      "https://api.housecallpro.test",
    );
    expect(client).toBeInstanceOf(RestHousecallProClient);
  });

  it("returns a client from the env fallback when no connection exists", async () => {
    process.env.HOUSECALL_API_KEY = "env-key";
    getOrgHousecallApiKey.mockResolvedValue(null);
    const client = await getHousecallClient(
      "org-1",
      explodingFetch,
      "https://api.housecallpro.test",
    );
    expect(client).toBeInstanceOf(RestHousecallProClient);
  });
});
