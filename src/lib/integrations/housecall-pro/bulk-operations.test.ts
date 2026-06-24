import { describe, it, expect } from "vitest";
import {
  validateBulkOperations,
  MAX_BULK_OPERATIONS,
} from "./bulk-operations";
import type { BulkJobOperation } from "./bulk-types";

const cancelOp: BulkJobOperation = {
  hcpJobId: "job-1",
  serviceRequestId: "req-1",
  action: "cancel",
};
const noteOp: BulkJobOperation = {
  hcpJobId: "job-2",
  serviceRequestId: "req-2",
  action: "note",
  note: "On the way",
};

describe("validateBulkOperations", () => {
  it("accepts a valid batch of cancel + note operations", () => {
    expect(validateBulkOperations([cancelOp, noteOp])).toEqual([]);
  });

  it("rejects an empty batch", () => {
    expect(validateBulkOperations([])).toContain("Operations array cannot be empty");
  });

  it("rejects a batch over the cap", () => {
    const tooMany = Array.from({ length: MAX_BULK_OPERATIONS + 1 }, () => cancelOp);
    expect(validateBulkOperations(tooMany)).toContain(
      `Operations array cannot exceed ${MAX_BULK_OPERATIONS} items`,
    );
  });

  it("rejects an unsupported action (no arbitrary status on HCP)", () => {
    const bad = { ...cancelOp, action: "complete" } as unknown as BulkJobOperation;
    expect(validateBulkOperations([bad])).toContain(
      'Operation at index 0: action must be "note" or "cancel"',
    );
  });

  it("requires a note when the action is 'note'", () => {
    const missingNote = { hcpJobId: "j", serviceRequestId: "r", action: "note" } as BulkJobOperation;
    expect(validateBulkOperations([missingNote])).toContain(
      'Operation at index 0: a note is required when action is "note"',
    );
    const blankNote = { ...missingNote, note: "   " } as BulkJobOperation;
    expect(validateBulkOperations([blankNote])).toContain(
      'Operation at index 0: a note is required when action is "note"',
    );
  });

  it("flags missing identifiers with the offending index", () => {
    const bad = { action: "cancel" } as unknown as BulkJobOperation;
    const errors = validateBulkOperations([bad]);
    expect(errors).toContain("Operation at index 0: missing or invalid hcpJobId");
    expect(errors).toContain("Operation at index 0: missing or invalid serviceRequestId");
  });

  it("does not require a note for a cancel action", () => {
    expect(validateBulkOperations([cancelOp])).toEqual([]);
  });
});

import { vi, beforeEach } from "vitest";
import { bulkJobOperations, aggregateBulkErrors } from "./bulk-operations";
import { housecallRateLimiter } from "./rate-limiter";
import type { HousecallProClient } from "./client";
import type { BulkJobOperationResult } from "./bulk-types";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Fast + deterministic: no inter-item delay, single worker (preserves order).
const FAST = { batchDelayMs: 0, maxConcurrency: 1 } as const;

function fakeClient(over: Partial<HousecallProClient>): HousecallProClient {
  return {
    cancelJob: vi.fn(async () => {}),
    addJobNote: vi.fn(async () => {}),
    ...over,
  } as unknown as HousecallProClient;
}

beforeEach(() => {
  housecallRateLimiter.resetAll(); // fresh buckets → no rate-limit sleeps
});

describe("bulkJobOperations", () => {
  it("routes cancel→cancelJob and note→addJobNote, all succeed", async () => {
    const cancelJob = vi.fn(async () => {});
    const addJobNote = vi.fn(async () => {});
    const client = fakeClient({ cancelJob, addJobNote });

    const summary = await bulkJobOperations(
      client,
      [
        { hcpJobId: "j1", serviceRequestId: "r1", action: "cancel" },
        { hcpJobId: "j2", serviceRequestId: "r2", action: "note", note: "hi" },
      ],
      FAST,
      "org-1",
    );

    expect(cancelJob).toHaveBeenCalledWith("j1");
    expect(addJobNote).toHaveBeenCalledWith("j2", "hi");
    expect(summary).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    // Results preserve input order.
    expect(summary.results.map((r) => r.hcpJobId)).toEqual(["j1", "j2"]);
  });

  it("reports failure per-item and still completes the batch (partial success)", async () => {
    const client = fakeClient({
      cancelJob: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("api blew up");
      }),
    });

    const summary = await bulkJobOperations(
      client,
      [
        { hcpJobId: "ok1", serviceRequestId: "r1", action: "cancel" },
        { hcpJobId: "bad", serviceRequestId: "r2", action: "cancel" },
        { hcpJobId: "ok2", serviceRequestId: "r3", action: "cancel" },
      ],
      FAST,
      "org-1",
    );

    expect(summary).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    const bad = summary.results.find((r) => r.hcpJobId === "bad")!;
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("api blew up");
  });

  it("continueOnError=false aborts remaining items after the first failure", async () => {
    const cancelJob = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("nope");
    });
    const client = fakeClient({ cancelJob });

    const summary = await bulkJobOperations(
      client,
      [
        { hcpJobId: "bad", serviceRequestId: "r1", action: "cancel" },
        { hcpJobId: "never", serviceRequestId: "r2", action: "cancel" },
      ],
      { ...FAST, continueOnError: false, maxRetries: 0 },
      "org-1",
    );

    // The second op was never attempted.
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith("bad");
    expect(summary.failed).toBe(1);
    expect(summary.results).toHaveLength(1);
  });

  it("retries a transient (5xx) failure then succeeds", async () => {
    let calls = 0;
    const cancelJob = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("503 Service Unavailable");
    });
    const client = fakeClient({ cancelJob });

    const summary = await bulkJobOperations(
      client,
      [{ hcpJobId: "j1", serviceRequestId: "r1", action: "cancel" }],
      { ...FAST, maxRetries: 2 },
      "org-1",
    );

    expect(calls).toBe(2); // failed once, retried, succeeded
    expect(summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
  });
});

describe("aggregateBulkErrors", () => {
  it("groups failures by category with a capped id sample", () => {
    const results: BulkJobOperationResult[] = [
      { hcpJobId: "a", serviceRequestId: "ra", success: false, error: "429 rate limit" },
      { hcpJobId: "b", serviceRequestId: "rb", success: false, error: "rate limit hit" },
      { hcpJobId: "c", serviceRequestId: "rc", success: true },
      { hcpJobId: "d", serviceRequestId: "rd", success: false, error: "request timeout" },
    ];
    const agg = aggregateBulkErrors(results);
    const rl = agg.find((e) => e.type === "rate_limit")!;
    expect(rl.count).toBe(2);
    expect(rl.sampleJobIds).toEqual(["a", "b"]);
    expect(agg.find((e) => e.type === "network")?.count).toBe(1);
  });
});
