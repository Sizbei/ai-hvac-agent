import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HousecallProClient } from "./client";
import type { HousecallJob } from "./types";

// ── Mock the HCP client factory ──────────────────────────────────────────────
// getHousecallClient returns null when the org isn't connected; otherwise a fake
// client whose listCustomerJobs we control per test. Keeps the real HCP API and
// the network entirely out of the test.
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

// Logger is a side-effect-only dependency in the degrade path; stub it silent.
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getCustomerServiceHistory,
  summarizeServiceHistory,
} from "./customer-history";

const ORG = "org-1";
const HCP_ID = "hcp-cust-1";

/** Build a typed job with a controllable schedule_start/description. */
function job(over: Partial<HousecallJob>): HousecallJob {
  return {
    id: "job-x",
    customer_id: HCP_ID,
    work_status: "completed",
    description: null,
    schedule_start: null,
    schedule_end: null,
    ...over,
  };
}

/** A fake client exposing only listCustomerJobs (the surface under test). */
function fakeClient(
  listCustomerJobs: HousecallProClient["listCustomerJobs"],
): HousecallProClient {
  return { listCustomerJobs } as unknown as HousecallProClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarizeServiceHistory (pure)", () => {
  it("returns empty summary for no jobs", () => {
    expect(summarizeServiceHistory([])).toEqual({
      jobCount: 0,
      lastServiceDate: null,
      lastServiceDescription: null,
    });
  });

  it("counts jobs and picks the most-recent by schedule_start", () => {
    const summary = summarizeServiceHistory([
      job({
        id: "old",
        schedule_start: "2026-01-10T12:00:00.000Z",
        description: "Old visit",
      }),
      job({
        id: "new",
        schedule_start: "2026-03-15T12:00:00.000Z",
        description: "Replaced capacitor",
      }),
      job({
        id: "mid",
        schedule_start: "2026-02-01T12:00:00.000Z",
        description: "Mid visit",
      }),
    ]);
    expect(summary.jobCount).toBe(3);
    expect(summary.lastServiceDate).toBe("2026-03-15T12:00:00.000Z");
    expect(summary.lastServiceDescription).toBe("Replaced capacitor");
  });

  it("does not leak the customer name (PII-free: only count/date/description)", () => {
    const summary = summarizeServiceHistory([
      job({ description: "Furnace repair", schedule_start: "2026-03-01T12:00:00.000Z" }),
    ]);
    expect(Object.keys(summary).sort()).toEqual([
      "jobCount",
      "lastServiceDate",
      "lastServiceDescription",
    ]);
    expect(JSON.stringify(summary)).not.toContain("customer_id");
  });
});

describe("getCustomerServiceHistory", () => {
  it("maps the client's jobs to a summary", async () => {
    getHousecallClient.mockResolvedValue(
      fakeClient(async () => [
        job({
          id: "a",
          schedule_start: "2026-03-15T12:00:00.000Z",
          description: "Replaced capacitor",
        }),
        job({ id: "b", schedule_start: "2026-01-01T12:00:00.000Z" }),
      ]),
    );

    const summary = await getCustomerServiceHistory(ORG, HCP_ID);
    expect(summary.jobCount).toBe(2);
    expect(summary.lastServiceDate).toBe("2026-03-15T12:00:00.000Z");
    expect(summary.lastServiceDescription).toBe("Replaced capacitor");
  });

  it("returns empty when the org is not HCP-connected (null client)", async () => {
    getHousecallClient.mockResolvedValue(null);
    const summary = await getCustomerServiceHistory(ORG, HCP_ID);
    expect(summary).toEqual({
      jobCount: 0,
      lastServiceDate: null,
      lastServiceDescription: null,
    });
  });

  it("returns empty when the client throws (degrade-safe, no rethrow)", async () => {
    getHousecallClient.mockResolvedValue(
      fakeClient(async () => {
        throw new Error("HTTP 500");
      }),
    );
    const summary = await getCustomerServiceHistory(ORG, HCP_ID);
    expect(summary).toEqual({
      jobCount: 0,
      lastServiceDate: null,
      lastServiceDescription: null,
    });
  });

  it("returns empty when the client factory itself rejects (degrade-safe)", async () => {
    getHousecallClient.mockRejectedValue(new Error("config blew up"));
    const summary = await getCustomerServiceHistory(ORG, HCP_ID);
    expect(summary.jobCount).toBe(0);
  });

  it("does not include the customer name in the summary (PII-free)", async () => {
    getHousecallClient.mockResolvedValue(
      fakeClient(async () => [
        job({
          id: "a",
          schedule_start: "2026-03-15T12:00:00.000Z",
          description: "Furnace repair",
        }),
      ]),
    );
    const summary = await getCustomerServiceHistory(ORG, HCP_ID);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("customer_id");
    expect(serialized).not.toContain("first_name");
    expect(Object.keys(summary).sort()).toEqual([
      "jobCount",
      "lastServiceDate",
      "lastServiceDescription",
    ]);
  });
});
