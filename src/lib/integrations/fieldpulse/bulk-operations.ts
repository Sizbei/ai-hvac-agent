/**
 * FIELDPULSE BULK OPERATIONS
 *
 * Handles bulk job status updates with rate limiting, partial success mode,
 * and comprehensive error aggregation.
 *
 * ┌─ BULK OPERATIONS ─────────────────────────────────────────────────────────┐
 * │ - Chunked processing for large batches                                    │
 * │ - Token bucket rate limiting with adaptive throttling                    │
 * │ - Partial success mode (continues on individual failures)                │
 * │ - Comprehensive error aggregation and reporting                          │
 * │ - Idempotent operation support for safe retries                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "./client";
import type {
  BulkJobStatusUpdate,
  BulkJobUpdateResult,
  BulkOperationSummary,
  BulkOperationOptions,
  BulkOperationError,
  RateLimitInfo,
} from "./bulk-types";
import { fieldpulseRateLimiter, waitForRateLimit } from "./rate-limiter";

/**
 * Default options for bulk operations.
 */
const DEFAULT_OPTIONS: Required<BulkOperationOptions> = {
  maxConcurrency: 5,
  batchDelayMs: 100,
  continueOnError: true,
  requestTimeoutMs: 10000,
  maxRetries: 2,
} as const;

/**
 * Result of processing a single job update with retry logic.
 */
interface ProcessedUpdate {
  readonly result: BulkJobUpdateResult;
  readonly shouldRetry: boolean;
}

/**
 * Process a single job status update with timeout and retry handling.
 */
async function processSingleUpdate(
  client: FieldpulseClient,
  update: BulkJobStatusUpdate,
  attempt: number,
  options: Required<BulkOperationOptions>,
  clientId: string,
): Promise<ProcessedUpdate> {
  try {
    // Wait for rate limit before each request
    const delay = await waitForRateLimit(clientId);
    if (delay > 0 && attempt === 0) {
      logger.debug(
        { clientId, delay, fieldpulseJobId: update.fieldpulseJobId },
        "Rate limit delay applied"
      );
    }

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Request timeout")), options.requestTimeoutMs);
    });

    // Attempt the update with timeout. The work status IS the point of a bulk
    // status update — send it. The note is appended separately via addJobNote
    // below, not jammed into description.
    const job = await Promise.race([
      client.updateJob(update.fieldpulseJobId, {
        workStatus: update.workStatus,
      }),
      timeoutPromise,
    ]);

    // Report success to rate limiter (gradual recovery)
    fieldpulseRateLimiter.reportSuccess(clientId);

    // Add note if provided
    if (update.note) {
      try {
        await client.addJobNote(update.fieldpulseJobId, update.note);
      } catch (noteError) {
        // Note failure is non-critical, log but don't fail the update
        logger.warn(
          { fieldpulseJobId: update.fieldpulseJobId, error: noteError },
          "Failed to add job note (non-critical)"
        );
      }
    }

    return {
      result: {
        fieldpulseJobId: update.fieldpulseJobId,
        serviceRequestId: update.serviceRequestId,
        success: true,
        job,
      },
      shouldRetry: false,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes("timeout");
    const isRateLimit = errorMessage.includes("429") || errorMessage.includes("rate limit");

    // Report throttle to rate limiter for adaptive backoff
    if (isRateLimit) {
      fieldpulseRateLimiter.reportThrottle(clientId);
    }

    // Determine if should retry (transient errors)
    // Retry on: rate limits, timeouts, 5xx errors, and network errors
    const shouldRetry =
      (isRateLimit ||
        isTimeout ||
        errorMessage.includes("5xx") ||
        errorMessage.includes("50") ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("ENOTFOUND")) &&
      attempt < options.maxRetries;

    return {
      result: {
        fieldpulseJobId: update.fieldpulseJobId,
        serviceRequestId: update.serviceRequestId,
        success: false,
        error: errorMessage,
        statusCode: isRateLimit ? 429 : isTimeout ? 408 : 500,
      },
      shouldRetry,
    };
  }
}

/**
 * Process a batch of updates with controlled concurrency.
 */
async function processBatch(
  client: FieldpulseClient,
  updates: readonly BulkJobStatusUpdate[],
  options: Required<BulkOperationOptions>,
  clientId: string,
): Promise<BulkJobUpdateResult[]> {
  // Bounded worker pool: at most maxConcurrency workers pull from a shared
  // index. Each worker owns and awaits its own task, so a failure NEVER orphans
  // a sibling promise (no unhandled rejections). When continueOnError is false,
  // `aborted` stops workers from STARTING new items — in-flight requests can't
  // be cancelled mid-flight, but no further API budget is consumed.
  const results = new Array<BulkJobUpdateResult | undefined>(updates.length);
  let nextIndex = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) {
        return;
      }
      const index = nextIndex++;
      if (index >= updates.length) {
        return;
      }
      const update = updates[index]!;

      let attempt = 0;
      let processed: ProcessedUpdate;
      do {
        processed = await processSingleUpdate(
          client,
          update,
          attempt,
          options,
          clientId,
        );
        attempt++;
      } while (processed.shouldRetry && !aborted);

      results[index] = processed.result;

      if (!processed.result.success && !options.continueOnError) {
        aborted = true;
        return;
      }

      // Pace each worker between its items (cheap inter-request smoothing on
      // top of the rate limiter).
      if (options.batchDelayMs > 0 && !aborted) {
        await sleep(options.batchDelayMs);
      }
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(options.maxConcurrency, updates.length),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Drop holes left by an early abort; preserve input order otherwise.
  return results.filter((r): r is BulkJobUpdateResult => r !== undefined);
}

/**
 * Aggregate errors by type for monitoring and alerting.
 */
function aggregateErrors(
  results: readonly BulkJobUpdateResult[],
): BulkOperationError[] {
  const errorMap = new Map<string, BulkOperationError>();

  for (const result of results) {
    if (result.success) continue;

    const error = result.error ?? "unknown";
    let type: BulkOperationError["type"] = "unknown";

    if (result.statusCode === 429 || error.includes("rate limit")) {
      type = "rate_limit";
    } else if (result.statusCode === 408 || error.includes("timeout")) {
      type = "network";
    } else if (result.statusCode && result.statusCode >= 500) {
      type = "api_error";
    } else if (error.includes("invalid") || error.includes("validation")) {
      type = "validation";
    }

    const existing = errorMap.get(type);
    if (existing) {
      // Increment count and update sample if needed
      const updated: BulkOperationError = {
        type,
        count: existing.count + 1,
        message: error,
        sampleJobIds: [...existing.sampleJobIds, result.fieldpulseJobId].slice(-10),
      };
      errorMap.set(type, updated);
    } else {
      errorMap.set(type, {
        type,
        count: 1,
        message: error,
        sampleJobIds: [result.fieldpulseJobId],
      });
    }
  }

  return Array.from(errorMap.values());
}

/**
 * Execute bulk job status updates with rate limiting and error aggregation.
 *
 * @param client - Fieldpulse client instance
 * @param updates - Array of job status updates to perform
 * @param options - Bulk operation options
 * @param clientId - Unique identifier for rate limiting (e.g., organization ID)
 * @returns Summary of the bulk operation with detailed results
 */
export async function bulkUpdateJobStatus(
  client: FieldpulseClient,
  updates: readonly BulkJobStatusUpdate[],
  options: BulkOperationOptions = {},
  clientId: string = "default",
): Promise<BulkOperationSummary> {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = new Date().toISOString();

  logger.info(
    { clientId, updateCount: updates.length, options: resolvedOptions },
    "Starting bulk job status update"
  );

  const results = await processBatch(client, updates, resolvedOptions, clientId);

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(startedAt).getTime();

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  const summary: BulkOperationSummary = {
    total: updates.length,
    succeeded,
    failed,
    results,
    startedAt,
    completedAt,
    durationMs,
  };

  logger.info(
    {
      clientId,
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      durationMs: summary.durationMs,
    },
    "Bulk job status update completed"
  );

  // Log aggregated errors for monitoring
  const aggregatedErrors = aggregateErrors(results);
  if (aggregatedErrors.length > 0) {
    logger.warn(
      { clientId, aggregatedErrors },
      "Bulk operation had aggregated errors"
    );
  }

  return summary;
}

/**
 * Get current rate limit info for a client.
 */
export function getRateLimitInfo(clientId: string = "default"): RateLimitInfo {
  return fieldpulseRateLimiter.checkLimit(clientId);
}

/**
 * Reset rate limiter state for a client.
 */
export function resetRateLimiter(clientId: string = "default"): void {
  fieldpulseRateLimiter.resetClient(clientId);
}

/**
 * Sleep utility (internal).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate bulk update input before processing.
 */
export function validateBulkUpdates(
  updates: readonly BulkJobStatusUpdate[],
): readonly string[] {
  const errors: string[] = [];

  if (!Array.isArray(updates)) {
    errors.push("Updates must be an array");
    return errors;
  }

  if (updates.length === 0) {
    errors.push("Updates array cannot be empty");
    return errors;
  }

  if (updates.length > 1000) {
    errors.push("Updates array cannot exceed 1000 items");
  }

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i]!;
    if (!update.fieldpulseJobId || typeof update.fieldpulseJobId !== "string") {
      errors.push(`Update at index ${i}: missing or invalid fieldpulseJobId`);
    }
    if (!update.serviceRequestId || typeof update.serviceRequestId !== "string") {
      errors.push(`Update at index ${i}: missing or invalid serviceRequestId`);
    }
    if (!update.workStatus || typeof update.workStatus !== "string") {
      errors.push(`Update at index ${i}: missing or invalid workStatus`);
    }
  }

  return errors;
}
