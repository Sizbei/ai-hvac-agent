/**
 * HOUSECALL PRO BULK OPERATIONS — TYPES
 *
 * Shapes for bulk job operations against HCP, with partial-success mode and
 * error aggregation. Mirrors the FieldPulse bulk types, ADAPTED to HCP's API
 * surface: HCP's `updateJob` has no `work_status` setter (unlike FieldPulse), so
 * the only job mutations HCP exposes are `cancelJob` and `addJobNote`. The bulk
 * operation is therefore an `action` of `"note" | "cancel"` — there is no
 * arbitrary status update (documented HCP-only limitation; see bulk-operations).
 */

/** A single job operation in a bulk batch. */
export interface BulkJobOperation {
  /** HCP job id to operate on. */
  readonly hcpJobId: string;
  /** Our internal service request id (for tracking/correlation). */
  readonly serviceRequestId: string;
  /** The mutation to apply — the two HCP demonstrably supports. */
  readonly action: "note" | "cancel";
  /** Note body — REQUIRED when `action === "note"`, ignored otherwise. */
  readonly note?: string;
}

/** Result of a single operation within a bulk batch. */
export interface BulkJobOperationResult {
  readonly hcpJobId: string;
  readonly serviceRequestId: string;
  /** Whether this individual operation succeeded. */
  readonly success: boolean;
  /** Error message if it failed. */
  readonly error?: string;
}

/** Summary of a bulk operation execution. */
export interface BulkOperationSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkJobOperationResult[];
  /** ISO datetime the batch started. */
  readonly startedAt: string;
  /** ISO datetime the batch completed. */
  readonly completedAt: string;
  readonly durationMs: number;
}

/** Aggregated error grouped by category, for monitoring. */
export interface BulkOperationError {
  readonly type: "validation" | "rate_limit" | "network" | "api_error" | "unknown";
  readonly count: number;
  /** Example error message. */
  readonly message: string;
  /** Affected job ids (sample, up to 10). */
  readonly sampleJobIds: readonly string[];
}

/** Options controlling bulk-operation behavior. */
export interface BulkOperationOptions {
  /** Max concurrent requests to HCP (default: 5). */
  readonly maxConcurrency?: number;
  /** Delay between batches in milliseconds (default: 100). */
  readonly batchDelayMs?: number;
  /** Continue past individual failures for partial success (default: true). */
  readonly continueOnError?: boolean;
  /** Timeout for an individual request in milliseconds (default: 10000). */
  readonly requestTimeoutMs?: number;
  /** Max retry attempts for transient failures (default: 2). */
  readonly maxRetries?: number;
}

/** Request body for the bulk-operation admin endpoint. */
export interface BulkOperationRequest {
  readonly operations: readonly BulkJobOperation[];
  readonly options?: BulkOperationOptions;
}

/** Response from the bulk-operation admin endpoint. */
export interface BulkOperationResponse {
  readonly summary: BulkOperationSummary;
  /** Aggregated errors grouped by type (for monitoring). */
  readonly aggregatedErrors?: readonly BulkOperationError[];
  /** Whether every operation succeeded. */
  readonly completeSuccess: boolean;
}
