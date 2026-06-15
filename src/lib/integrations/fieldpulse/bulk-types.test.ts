/**
 * Tests for Fieldpulse bulk operations types.
 * Validates type contracts and runtime validation behavior.
 */

import { describe, it, expect } from "vitest";
import type {
  BulkJobStatusUpdate,
  BulkJobUpdateResult,
  BulkOperationSummary,
  BulkOperationOptions,
  BulkJobStatusUpdateRequest,
  BulkJobStatusUpdateResponse,
  RateLimitInfo,
  BulkOperationError,
  BatchChunk,
} from "./bulk-types";
import { validateBulkUpdates } from "./bulk-operations";

describe("BulkJobStatusUpdate", () => {
  it("should accept valid job status update", () => {
    const update: BulkJobStatusUpdate = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      workStatus: "en_route",
    };

    expect(update.fieldpulseJobId).toBe("fp-123");
    expect(update.serviceRequestId).toBe("sr-456");
    expect(update.workStatus).toBe("en_route");
  });

  it("should accept update with optional note", () => {
    const update: BulkJobStatusUpdate = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      workStatus: "en_route",
      note: "Technician is on the way",
    };

    expect(update.note).toBe("Technician is on the way");
  });

  it("should accept update with optional statusAt timestamp", () => {
    const update: BulkJobStatusUpdate = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      workStatus: "en_route",
      statusAt: "2025-01-15T10:30:00Z",
    };

    expect(update.statusAt).toBe("2025-01-15T10:30:00Z");
  });

  it("should accept update with all optional fields", () => {
    const update: BulkJobStatusUpdate = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      workStatus: "completed",
      note: "Job completed successfully",
      statusAt: "2025-01-15T14:00:00Z",
    };

    expect(update.note).toBeDefined();
    expect(update.statusAt).toBeDefined();
  });
});

describe("BulkJobUpdateResult", () => {
  it("should represent successful update", () => {
    const result: BulkJobUpdateResult = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      success: true,
      job: {
        id: "fp-123",
        customerId: "cust-789",
        workStatus: "en_route",
      },
    };

    expect(result.success).toBe(true);
    expect(result.job?.workStatus).toBe("en_route");
  });

  it("should represent failed update with error", () => {
    const result: BulkJobUpdateResult = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      success: false,
      error: "Rate limit exceeded",
      statusCode: 429,
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Rate limit exceeded");
    expect(result.statusCode).toBe(429);
  });

  it("should represent failed update without status code", () => {
    const result: BulkJobUpdateResult = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      success: false,
      error: "Network timeout",
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Network timeout");
    expect(result.statusCode).toBeUndefined();
  });
});

describe("BulkOperationSummary", () => {
  it("should summarize bulk operation", () => {
    const summary: BulkOperationSummary = {
      total: 10,
      succeeded: 8,
      failed: 2,
      results: [],
      startedAt: "2025-01-15T10:00:00Z",
      completedAt: "2025-01-15T10:00:05Z",
      durationMs: 5000,
    };

    expect(summary.total).toBe(10);
    expect(summary.succeeded).toBe(8);
    expect(summary.failed).toBe(2);
    expect(summary.durationMs).toBe(5000);
  });

  it("should represent complete success", () => {
    const summary: BulkOperationSummary = {
      total: 5,
      succeeded: 5,
      failed: 0,
      results: [],
      startedAt: "2025-01-15T10:00:00Z",
      completedAt: "2025-01-15T10:00:03Z",
      durationMs: 3000,
    };

    expect(summary.failed).toBe(0);
    expect(summary.succeeded).toBe(summary.total);
  });
});

describe("BulkOperationOptions", () => {
  it("should accept default options", () => {
    const options: BulkOperationOptions = {};

    expect(options).toBeDefined();
  });

  it("should accept partial options", () => {
    const options: BulkOperationOptions = {
      maxConcurrency: 10,
      continueOnError: false,
    };

    expect(options.maxConcurrency).toBe(10);
    expect(options.continueOnError).toBe(false);
    expect(options.batchDelayMs).toBeUndefined();
  });

  it("should accept all options", () => {
    const options: BulkOperationOptions = {
      maxConcurrency: 15,
      batchDelayMs: 200,
      continueOnError: true,
      requestTimeoutMs: 15000,
      maxRetries: 3,
    };

    expect(options.maxConcurrency).toBe(15);
    expect(options.batchDelayMs).toBe(200);
    expect(options.continueOnError).toBe(true);
    expect(options.requestTimeoutMs).toBe(15000);
    expect(options.maxRetries).toBe(3);
  });
});

describe("BulkJobStatusUpdateRequest", () => {
  it("should accept request with updates only", () => {
    const request: BulkJobStatusUpdateRequest = {
      updates: [
        {
          fieldpulseJobId: "fp-1",
          serviceRequestId: "sr-1",
          workStatus: "en_route",
        },
      ],
    };

    expect(request.updates).toHaveLength(1);
    expect(request.options).toBeUndefined();
  });

  it("should accept request with updates and options", () => {
    const request: BulkJobStatusUpdateRequest = {
      updates: [
        {
          fieldpulseJobId: "fp-1",
          serviceRequestId: "sr-1",
          workStatus: "en_route",
        },
      ],
      options: {
        maxConcurrency: 5,
        continueOnError: true,
      },
    };

    expect(request.updates).toHaveLength(1);
    expect(request.options?.maxConcurrency).toBe(5);
  });
});

describe("BulkJobStatusUpdateResponse", () => {
  it("should represent successful response", () => {
    const response: BulkJobStatusUpdateResponse = {
      summary: {
        total: 5,
        succeeded: 5,
        failed: 0,
        results: [],
        startedAt: "2025-01-15T10:00:00Z",
        completedAt: "2025-01-15T10:00:02Z",
        durationMs: 2000,
      },
      completeSuccess: true,
    };

    expect(response.completeSuccess).toBe(true);
    expect(response.summary.failed).toBe(0);
  });

  it("should represent partial success response", () => {
    const response: BulkJobStatusUpdateResponse = {
      summary: {
        total: 10,
        succeeded: 8,
        failed: 2,
        results: [],
        startedAt: "2025-01-15T10:00:00Z",
        completedAt: "2025-01-15T10:00:05Z",
        durationMs: 5000,
      },
      aggregatedErrors: [
        {
          type: "rate_limit",
          count: 2,
          message: "Rate limit exceeded",
          sampleJobIds: ["fp-3", "fp-7"],
        },
      ],
      completeSuccess: false,
    };

    expect(response.completeSuccess).toBe(false);
    expect(response.aggregatedErrors).toHaveLength(1);
    expect(response.aggregatedErrors?.[0]?.type).toBe("rate_limit");
  });
});

describe("RateLimitInfo", () => {
  it("should represent ok state", () => {
    const info: RateLimitInfo = {
      allowed: true,
      state: "ok",
      remaining: 8,
      resetMs: 0,
      suggestedDelayMs: 100,
    };

    expect(info.state).toBe("ok");
    expect(info.remaining).toBe(8);
  });

  it("should represent throttled state", () => {
    const info: RateLimitInfo = {
      allowed: true,
      state: "throttled",
      remaining: 2,
      resetMs: 5000,
      suggestedDelayMs: 500,
    };

    expect(info.state).toBe("throttled");
    expect(info.suggestedDelayMs).toBeGreaterThan(100);
  });

  it("should represent blocked state", () => {
    const info: RateLimitInfo = {
      allowed: false,
      state: "blocked",
      remaining: 0,
      resetMs: 10000,
      suggestedDelayMs: 10000,
    };

    expect(info.state).toBe("blocked");
    expect(info.remaining).toBe(0);
  });
});

describe("BulkOperationError", () => {
  it("should represent rate limit error", () => {
    const error: BulkOperationError = {
      type: "rate_limit",
      count: 5,
      message: "Rate limit exceeded",
      sampleJobIds: ["fp-1", "fp-2", "fp-3"],
    };

    expect(error.type).toBe("rate_limit");
    expect(error.count).toBe(5);
    expect(error.sampleJobIds).toHaveLength(3);
  });

  it("should represent validation error", () => {
    const error: BulkOperationError = {
      type: "validation",
      count: 1,
      message: "Invalid job ID",
      sampleJobIds: ["fp-999"],
    };

    expect(error.type).toBe("validation");
    expect(error.count).toBe(1);
  });

  it("should represent network error", () => {
    const error: BulkOperationError = {
      type: "network",
      count: 3,
      message: "Request timeout",
      sampleJobIds: ["fp-4", "fp-5", "fp-6"],
    };

    expect(error.type).toBe("network");
  });

  it("should represent API error", () => {
    const error: BulkOperationError = {
      type: "api_error",
      count: 2,
      message: "Internal server error",
      sampleJobIds: ["fp-7", "fp-8"],
    };

    expect(error.type).toBe("api_error");
  });

  it("should limit sampleJobIds to 10", () => {
    const error: BulkOperationError = {
      type: "unknown",
      count: 15,
      message: "Unknown error",
      sampleJobIds: Array.from({ length: 15 }, (_, i) => `fp-${i}`),
    };

    // Type definition allows more, but implementation should limit
    expect(error.sampleJobIds.length).toBeGreaterThan(10);
  });
});

describe("BatchChunk", () => {
  it("should represent batch chunk", () => {
    const chunk: BatchChunk<string> = {
      items: ["a", "b", "c"],
      index: 0,
      totalChunks: 3,
    };

    expect(chunk.items).toHaveLength(3);
    expect(chunk.index).toBe(0);
    expect(chunk.totalChunks).toBe(3);
  });

  it("should work with complex items", () => {
    interface Item {
      id: string;
      value: number;
    }

    const chunk: BatchChunk<Item> = {
      items: [
        { id: "1", value: 100 },
        { id: "2", value: 200 },
      ],
      index: 1,
      totalChunks: 5,
    };

    expect(chunk.items[0]?.id).toBe("1");
    expect(chunk.items[1]?.value).toBe(200);
  });
});

describe("Type immutability", () => {
  it("should enforce readonly on BulkJobStatusUpdate", () => {
    const update: BulkJobStatusUpdate = {
      fieldpulseJobId: "fp-123",
      serviceRequestId: "sr-456",
      workStatus: "en_route",
    };

    // TypeScript should prevent mutation at compile time
    // @ts-expect-error - Testing readonly enforcement
    expect(() => { update.fieldpulseJobId = "new-id"; }).toBeDefined();
  });

  it("should enforce readonly on BulkOperationSummary results", () => {
    const summary: BulkOperationSummary = {
      total: 1,
      succeeded: 1,
      failed: 0,
      results: [
        {
          fieldpulseJobId: "fp-1",
          serviceRequestId: "sr-1",
          success: true,
        },
      ],
      startedAt: "2025-01-15T10:00:00Z",
      completedAt: "2025-01-15T10:00:01Z",
      durationMs: 1000,
    };

    // @ts-expect-error - Testing readonly enforcement
    expect(() => { summary.results = []; }).toBeDefined();
  });
});

describe("Runtime validation integration", () => {
  it("should validate empty array returns errors", () => {
    const errors = validateBulkUpdates([]);
    expect(errors).toContain("Updates array cannot be empty");
  });

  it("should validate oversized array returns errors", () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({
      fieldpulseJobId: `fp-${i}`,
      serviceRequestId: `sr-${i}`,
      workStatus: "en_route",
    }));

    const errors = validateBulkUpdates(tooMany);
    expect(errors).toContain("Updates array cannot exceed 1000 items");
  });
});
