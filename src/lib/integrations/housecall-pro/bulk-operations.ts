/**
 * HOUSECALL PRO BULK OPERATIONS
 *
 * Chunked, rate-limited bulk job operations against HCP with partial-success
 * mode and error aggregation — the HCP analog of fieldpulse/bulk-operations.
 *
 * HCP LIMITATION (intentional): HCP's `updateJob` has no `work_status` field, so
 * there is NO arbitrary bulk status update (unlike FieldPulse). The supported
 * actions are the two HCP demonstrably exposes — `cancel` (PUT /jobs/{id}/cancel)
 * and `note` (POST /jobs/{id}/notes). Each operation runs under the shared
 * Housecall rate limiter (`withHcpRateLimit`).
 *
 * This module is being built in slices: input validation + the bounded-worker-
 * pool executor ship here; the admin endpoint follows.
 */
import { logger } from "@/lib/logger";
import type { HousecallProClient } from "./client";
import type {
  BulkJobOperation,
  BulkJobOperationResult,
  BulkOperationSummary,
  BulkOperationOptions,
  BulkOperationError,
} from "./bulk-types";
import { withHcpRateLimit } from "./rate-limiter";

/** Hard cap on a single bulk batch (mirrors the FieldPulse limit). */
export const MAX_BULK_OPERATIONS = 1000;

const VALID_ACTIONS: ReadonlySet<string> = new Set(["note", "cancel"]);

/**
 * Validate a bulk-operation batch before processing. Pure + side-effect-free.
 * Returns a list of human-readable errors (empty = valid). Checks the batch
 * shape (non-empty, within {@link MAX_BULK_OPERATIONS}) and each operation's
 * required fields, the action enum, and that a `note` action carries a note.
 */
export function validateBulkOperations(
  operations: readonly BulkJobOperation[],
): readonly string[] {
  const errors: string[] = [];

  if (!Array.isArray(operations)) {
    errors.push("Operations must be an array");
    return errors;
  }
  if (operations.length === 0) {
    errors.push("Operations array cannot be empty");
    return errors;
  }
  if (operations.length > MAX_BULK_OPERATIONS) {
    errors.push(`Operations array cannot exceed ${MAX_BULK_OPERATIONS} items`);
  }

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    if (!op.hcpJobId || typeof op.hcpJobId !== "string") {
      errors.push(`Operation at index ${i}: missing or invalid hcpJobId`);
    }
    if (!op.serviceRequestId || typeof op.serviceRequestId !== "string") {
      errors.push(`Operation at index ${i}: missing or invalid serviceRequestId`);
    }
    if (!op.action || !VALID_ACTIONS.has(op.action)) {
      errors.push(`Operation at index ${i}: action must be "note" or "cancel"`);
    }
    if (op.action === "note" && (!op.note || !op.note.trim())) {
      errors.push(`Operation at index ${i}: a note is required when action is "note"`);
    }
  }

  return errors;
}

/** Default options for bulk operations. */
const DEFAULT_OPTIONS: Required<BulkOperationOptions> = {
  maxConcurrency: 5,
  batchDelayMs: 100,
  continueOnError: true,
  requestTimeoutMs: 10000,
  maxRetries: 2,
} as const;

interface ProcessedOp {
  readonly result: BulkJobOperationResult;
  readonly shouldRetry: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single operation (cancel | note) with a timeout, under the shared HCP
 * rate limiter. withHcpRateLimit waits for a token, reports success, and on a
 * 429 reports the throttle (adaptive backoff) before rethrowing — so the retry
 * classification below sees the error. The note IS the operation here (HCP has
 * no work_status), so there is no separate note call as in the FieldPulse port.
 */
async function processSingleOp(
  client: HousecallProClient,
  op: BulkJobOperation,
  attempt: number,
  options: Required<BulkOperationOptions>,
  clientId: string,
): Promise<ProcessedOp> {
  try {
    await withHcpRateLimit(clientId, async () => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Request timeout")), options.requestTimeoutMs);
      });
      const action =
        op.action === "cancel"
          ? client.cancelJob(op.hcpJobId)
          : client.addJobNote(op.hcpJobId, op.note ?? "");
      await Promise.race([action, timeoutPromise]);
    });
    return {
      result: { hcpJobId: op.hcpJobId, serviceRequestId: op.serviceRequestId, success: true },
      shouldRetry: false,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes("timeout");
    const isRateLimit =
      errorMessage.includes("429") || /rate limit/i.test(errorMessage);
    // Retry transient errors only (rate limit, timeout, 5xx, network).
    const shouldRetry =
      (isRateLimit ||
        isTimeout ||
        /\b5\d\d\b/.test(errorMessage) ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("ENOTFOUND")) &&
      attempt < options.maxRetries;
    return {
      result: {
        hcpJobId: op.hcpJobId,
        serviceRequestId: op.serviceRequestId,
        success: false,
        error: errorMessage,
      },
      shouldRetry,
    };
  }
}

/**
 * Process the batch with a bounded worker pool: at most maxConcurrency workers
 * pull from a shared index, each owning + awaiting its own task (a failure never
 * orphans a sibling promise). continueOnError=false stops workers from STARTING
 * new items (in-flight requests can't be cancelled, but no further budget is
 * spent). Preserves input order; drops holes left by an early abort.
 */
async function processBatch(
  client: HousecallProClient,
  operations: readonly BulkJobOperation[],
  options: Required<BulkOperationOptions>,
  clientId: string,
): Promise<BulkJobOperationResult[]> {
  const results = new Array<BulkJobOperationResult | undefined>(operations.length);
  let nextIndex = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) return;
      const index = nextIndex++;
      if (index >= operations.length) return;
      const op = operations[index]!;

      let attempt = 0;
      let processed: ProcessedOp;
      do {
        processed = await processSingleOp(client, op, attempt, options, clientId);
        attempt++;
      } while (processed.shouldRetry && !aborted);

      results[index] = processed.result;

      if (!processed.result.success && !options.continueOnError) {
        aborted = true;
        return;
      }
      if (options.batchDelayMs > 0 && !aborted) {
        await sleep(options.batchDelayMs);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(options.maxConcurrency, operations.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((r): r is BulkJobOperationResult => r !== undefined);
}

/** Aggregate failed results by category, for monitoring (sample up to 10 ids). */
function aggregateErrors(
  results: readonly BulkJobOperationResult[],
): BulkOperationError[] {
  const byType = new Map<string, BulkOperationError>();
  for (const r of results) {
    if (r.success) continue;
    const error = r.error ?? "unknown";
    let type: BulkOperationError["type"] = "unknown";
    if (/429|rate limit/i.test(error)) type = "rate_limit";
    else if (error.includes("timeout")) type = "network";
    else if (/\b5\d\d\b/.test(error)) type = "api_error";
    else if (/invalid|validation/i.test(error)) type = "validation";

    const existing = byType.get(type);
    byType.set(
      type,
      existing
        ? {
            type,
            count: existing.count + 1,
            message: error,
            sampleJobIds: [...existing.sampleJobIds, r.hcpJobId].slice(-10),
          }
        : { type, count: 1, message: error, sampleJobIds: [r.hcpJobId] },
    );
  }
  return Array.from(byType.values());
}

/**
 * Execute a batch of HCP job operations (cancel | note) with bounded
 * concurrency, per-item retry, the shared rate limiter, and partial-success
 * mode. `clientId` keys the rate limiter (use the organization id). Returns a
 * summary; callers should `validateBulkOperations` first.
 */
export async function bulkJobOperations(
  client: HousecallProClient,
  operations: readonly BulkJobOperation[],
  options: BulkOperationOptions = {},
  clientId = "default",
): Promise<BulkOperationSummary> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = new Date().toISOString();

  const results = await processBatch(client, operations, resolved, clientId);

  const completedAt = new Date().toISOString();
  const summary: BulkOperationSummary = {
    total: operations.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
    startedAt,
    completedAt,
    durationMs: Date.now() - new Date(startedAt).getTime(),
  };

  const aggregated = aggregateErrors(results);
  if (aggregated.length > 0) {
    logger.warn({ clientId, aggregated }, "HCP bulk operation had aggregated errors");
  }
  logger.info(
    { clientId, total: summary.total, succeeded: summary.succeeded, failed: summary.failed },
    "HCP bulk operation completed",
  );
  return summary;
}

/** Group aggregated errors for a response payload (exported for the route). */
export function aggregateBulkErrors(
  results: readonly BulkJobOperationResult[],
): BulkOperationError[] {
  return aggregateErrors(results);
}
