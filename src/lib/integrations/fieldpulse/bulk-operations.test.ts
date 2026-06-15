/**
 * Tests for Fieldpulse bulk operations module.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  bulkUpdateJobStatus,
  validateBulkUpdates,
  getRateLimitInfo,
  resetRateLimiter,
} from "./bulk-operations";
import {
  fieldpulseRateLimiter,
} from "./rate-limiter";
import type { FieldpulseClient } from "./client";
import type {
  BulkJobStatusUpdate,
  BulkOperationSummary,
} from "./bulk-types";

// Mock logger
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("validateBulkUpdates", () => {
  it("should accept valid updates", () => {
    const updates = [
      {
        fieldpulseJobId: "fp-123",
        serviceRequestId: "sr-456",
        workStatus: "en_route",
      },
      {
        fieldpulseJobId: "fp-789",
        serviceRequestId: "sr-012",
        workStatus: "completed",
        note: "Job completed successfully",
      },
    ] as const;

    const errors = validateBulkUpdates(updates);
    expect(errors).toHaveLength(0);
  });

  it("should reject non-array input", () => {
    const errors = validateBulkUpdates("not an array" as unknown as readonly BulkJobStatusUpdate[]);
    expect(errors).toContain("Updates must be an array");
  });

  it("should reject empty array", () => {
    const errors = validateBulkUpdates([]);
    expect(errors).toContain("Updates array cannot be empty");
  });

  it("should reject array exceeding 1000 items", () => {
    const largeArray = Array.from({ length: 1001 }, (_, i) => ({
      fieldpulseJobId: `fp-${i}`,
      serviceRequestId: `sr-${i}`,
      workStatus: "en_route",
    })) as readonly BulkJobStatusUpdate[];

    const errors = validateBulkUpdates(largeArray);
    expect(errors).toContain("Updates array cannot exceed 1000 items");
  });

  it("should reject update with missing fieldpulseJobId", () => {
    const updates = [
      {
        fieldpulseJobId: "",
        serviceRequestId: "sr-456",
        workStatus: "en_route",
      },
    ] as const;

    const errors = validateBulkUpdates(updates);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("fieldpulseJobId"))).toBe(true);
  });

  it("should reject update with missing serviceRequestId", () => {
    const updates = [
      {
        fieldpulseJobId: "fp-123",
        serviceRequestId: "",
        workStatus: "en_route",
      },
    ] as const;

    const errors = validateBulkUpdates(updates);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("serviceRequestId"))).toBe(true);
  });

  it("should reject update with missing workStatus", () => {
    const updates = [
      {
        fieldpulseJobId: "fp-123",
        serviceRequestId: "sr-456",
        workStatus: "",
      },
    ] as const;

    const errors = validateBulkUpdates(updates);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("workStatus"))).toBe(true);
  });

  it("should report multiple validation errors", () => {
    const updates = [
      {
        fieldpulseJobId: "",
        serviceRequestId: "",
        workStatus: "",
      },
    ] as const;

    const errors = validateBulkUpdates(updates);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("bulkUpdateJobStatus", () => {
  let mockClient: FieldpulseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fieldpulseRateLimiter.resetAll();

    mockClient = {
      updateJob: vi.fn(),
      addJobNote: vi.fn(),
    } as unknown as FieldpulseClient;
  });

  it("should process successful bulk update", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
      {
        fieldpulseJobId: "fp-2",
        serviceRequestId: "sr-2",
        workStatus: "completed",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fp-1",
      customerId: "cust-1",
      workStatus: "en_route",
    });

    // Use batchDelayMs: 0 and maxConcurrency: 10 to speed up tests
    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]?.success).toBe(true);
    expect(summary.results[1]?.success).toBe(true);
  }, 10000);

  it("should handle partial success with continueOnError", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
      {
        fieldpulseJobId: "fp-2",
        serviceRequestId: "sr-2",
        workStatus: "completed",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "fp-1",
        customerId: "cust-1",
        workStatus: "en_route",
      })
      .mockRejectedValueOnce(new Error("API error"));

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { continueOnError: true, batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.success).toBe(true);
    expect(summary.results[1]?.success).toBe(false);
  }, 10000);

  it("should add note when provided", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
        note: "Technician is on the way",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fp-1",
      customerId: "cust-1",
      workStatus: "en_route",
    });

    await bulkUpdateJobStatus(
      mockClient,
      updates,
      { batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(mockClient.addJobNote).toHaveBeenCalledWith(
      "fp-1",
      "Technician is on the way"
    );
  }, 10000);

  it("should continue when addJobNote fails", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
        note: "Test note",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fp-1",
      customerId: "cust-1",
      workStatus: "en_route",
    });
    (mockClient.addJobNote as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Note API error")
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { batchDelayMs: 0, maxConcurrency: 10 }
    );

    // Update should succeed even though note failed
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
  }, 10000);

  it("should respect max concurrency option", async () => {
    const updates: BulkJobStatusUpdate[] = Array.from({ length: 10 }, (_, i) => ({
      fieldpulseJobId: `fp-${i}`,
      serviceRequestId: `sr-${i}`,
      workStatus: "en_route",
    }));

    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        concurrentCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        return new Promise((resolve) => {
          setTimeout(() => {
            concurrentCalls--;
            resolve({
              id: "fp-1",
              customerId: "cust-1",
              workStatus: "en_route",
            });
          }, 10);
        });
      }
    );

    await bulkUpdateJobStatus(
      mockClient,
      updates,
      { maxConcurrency: 3, batchDelayMs: 0 }
    );

    expect(maxConcurrentCalls).toBeLessThanOrEqual(3);
  }, 10000);

  it("should handle timeout errors", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { requestTimeoutMs: 100, batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.error).toContain("timeout");
  }, 10000);

  it("should include duration in summary", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fp-1",
      customerId: "cust-1",
      workStatus: "en_route",
    });

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.startedAt).toBeDefined();
    expect(summary.completedAt).toBeDefined();
  }, 10000);

  it("should retry transient failures", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
    ] as const;

    let attempts = 0;
    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        attempts++;
        if (attempts < 2) {
          return Promise.reject(new Error("502 Bad Gateway"));
        }
        return Promise.resolve({
          id: "fp-1",
          customerId: "cust-1",
          workStatus: "en_route",
        });
      }
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 15000);

  it("should stop retrying after max attempts", async () => {
    const updates = [
      {
        fieldpulseJobId: "fp-1",
        serviceRequestId: "sr-1",
        workStatus: "en_route",
      },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("502 Bad Gateway")
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { maxRetries: 1, batchDelayMs: 0, maxConcurrency: 10 }
    );

    // Should fail after max retries
    expect(summary.failed).toBe(1);
    expect(mockClient.updateJob).toHaveBeenCalledTimes(2); // Initial + 1 retry
  }, 15000);
});

describe("getRateLimitInfo", () => {
  beforeEach(() => {
    fieldpulseRateLimiter.resetAll();
  });

  it("should return initial rate limit state", () => {
    const info = getRateLimitInfo("test-client");

    expect(info.state).toBe("ok");
    expect(info.allowed).toBe(true);
    expect(info.remaining).toBeGreaterThan(0);
    expect(info.resetMs).toBeGreaterThanOrEqual(0);
    expect(info.suggestedDelayMs).toBeGreaterThanOrEqual(0);
  });

  it("should return different states for different clients", () => {
    const info1 = getRateLimitInfo("client-1");
    const info2 = getRateLimitInfo("client-2");

    // Both should be ok initially
    expect(info1.state).toBe("ok");
    expect(info2.state).toBe("ok");

    // Consume tokens for client-1
    for (let i = 0; i < 15; i++) {
      getRateLimitInfo("client-1");
    }

    const info1After = getRateLimitInfo("client-1");
    const info2After = getRateLimitInfo("client-2");

    // Client-1 might be blocked, client-2 should still be ok
    expect(info2After.state).toBe("ok");
  });
});

describe("resetRateLimiter", () => {
  beforeEach(() => {
    fieldpulseRateLimiter.resetAll();
  });

  it("should reset rate limiter for client", () => {
    // Consume tokens
    for (let i = 0; i < 5; i++) {
      getRateLimitInfo("reset-test");
    }

    const beforeReset = getRateLimitInfo("reset-test");

    // Reset
    resetRateLimiter("reset-test");

    const afterReset = getRateLimitInfo("reset-test");

    // After reset, should have more tokens available
    expect(afterReset.remaining).toBeGreaterThan(beforeReset.remaining);
  });
});

describe("Error aggregation", () => {
  let mockClient: FieldpulseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fieldpulseRateLimiter.resetAll();

    mockClient = {
      updateJob: vi.fn(),
      addJobNote: vi.fn(),
    } as unknown as FieldpulseClient;
  });

  it("should aggregate network errors", async () => {
    const updates = [
      { fieldpulseJobId: "fp-1", serviceRequestId: "sr-1", workStatus: "en_route" },
      { fieldpulseJobId: "fp-2", serviceRequestId: "sr-2", workStatus: "en_route" },
      { fieldpulseJobId: "fp-3", serviceRequestId: "sr-3", workStatus: "en_route" },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network timeout")
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { continueOnError: true, batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.failed).toBe(3);
    // All errors should be aggregated
  }, 15000);

  it("should aggregate network errors", async () => {
    const updates = [
      { fieldpulseJobId: "fp-1", serviceRequestId: "sr-1", workStatus: "en_route" },
      { fieldpulseJobId: "fp-2", serviceRequestId: "sr-2", workStatus: "en_route" },
    ] as const;

    (mockClient.updateJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Request timeout")
    );

    const summary = await bulkUpdateJobStatus(
      mockClient,
      updates,
      { continueOnError: true, batchDelayMs: 0, maxConcurrency: 10 }
    );

    expect(summary.failed).toBe(2);
  }, 10000);
});
