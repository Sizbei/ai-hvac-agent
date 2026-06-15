/**
 * FIELDPULSE BULK OPERATIONS TYPES
 *
 * Types for bulk job status updates with rate limiting, partial success mode,
 * and comprehensive error aggregation.
 */

import type { FieldpulseJob } from "./types";

/**
 * Job status update for bulk operations.
 * Used when multiple jobs need status updates in a single batch.
 */
export interface BulkJobStatusUpdate {
  /** Fieldpulse job ID to update */
  readonly fieldpulseJobId: string;
  /** Our internal service request ID (for tracking) */
  readonly serviceRequestId: string;
  /** New work status (e.g., "en_route", "in_progress", "completed") */
  readonly workStatus: string;
  /** Optional note to append to the job */
  readonly note?: string;
  /** Optional timestamp for the status change */
  readonly statusAt?: string; // ISO datetime
}

/**
 * Result of a single job status update within a bulk operation.
 */
export interface BulkJobUpdateResult {
  /** The fieldpulse job ID that was updated */
  readonly fieldpulseJobId: string;
  /** Our internal service request ID */
  readonly serviceRequestId: string;
  /** Whether this individual update succeeded */
  readonly success: boolean;
  /** Error message if failed */
  readonly error?: string;
  /** HTTP status code from Fieldpulse (if applicable) */
  readonly statusCode?: number;
  /** Updated job data (if successful and returned) */
  readonly job?: FieldpulseJob;
}

/**
 * Summary of a bulk operation execution.
 */
export interface BulkOperationSummary {
  /** Total number of items in the batch */
  readonly total: number;
  /** Number of successful updates */
  readonly succeeded: number;
  /** Number of failed updates */
  readonly failed: number;
  /** Individual results for each item */
  readonly results: readonly BulkJobUpdateResult[];
  /** Timestamp when the bulk operation started */
  readonly startedAt: string; // ISO datetime
  /** Timestamp when the bulk operation completed */
  readonly completedAt: string; // ISO datetime
  /** Total duration in milliseconds */
  readonly durationMs: number;
}

/**
 * Aggregated error from a bulk operation.
 * Grouped by error type to provide actionable insights.
 */
export interface BulkOperationError {
  /** Error category/type */
  readonly type: "rate_limit" | "validation" | "network" | "api_error" | "unknown";
  /** Number of occurrences */
  readonly count: number;
  /** Example error message */
  readonly message: string;
  /** Affected job IDs (sample, up to 10) */
  readonly sampleJobIds: readonly string[];
}

/**
 * Bulk operation options for controlling behavior.
 */
export interface BulkOperationOptions {
  /** Maximum concurrent requests to Fieldpulse (default: 5) */
  readonly maxConcurrency?: number;
  /** Delay between batches in milliseconds (default: 100) */
  readonly batchDelayMs?: number;
  /** Continue on individual failures (default: true for partial success) */
  readonly continueOnError?: boolean;
  /** Timeout for individual requests in milliseconds (default: 10000) */
  readonly requestTimeoutMs?: number;
  /** Maximum retry attempts for transient failures (default: 2) */
  readonly maxRetries?: number;
}

/**
 * Request body for bulk job status update API endpoint.
 */
export interface BulkJobStatusUpdateRequest {
  /** Array of job status updates to perform */
  readonly updates: readonly BulkJobStatusUpdate[];
  /** Options for controlling bulk operation behavior */
  readonly options?: BulkOperationOptions;
}

/**
 * Response from bulk job status update API endpoint.
 */
export interface BulkJobStatusUpdateResponse {
  /** Summary of the bulk operation */
  readonly summary: BulkOperationSummary;
  /** Aggregated errors grouped by type (for monitoring) */
  readonly aggregatedErrors?: readonly BulkOperationError[];
  /** Whether the operation completed all updates successfully */
  readonly completeSuccess: boolean;
}

/**
 * Rate limit info for bulk operations.
 */
export interface RateLimitInfo {
  /** Whether the request is allowed within the rate limit */
  readonly allowed: boolean;
  /** Current rate limit state */
  readonly state: "ok" | "throttled" | "blocked";
  /** Number of requests remaining in current window */
  readonly remaining: number;
  /** Time until rate limit resets (milliseconds) */
  readonly resetMs: number;
  /** Suggested delay before next request (milliseconds) */
  readonly suggestedDelayMs: number;
}

/**
 * Chunked batch for processing large bulk operations.
 */
export interface BatchChunk<T> {
  /** Items in this chunk */
  readonly items: readonly T[];
  /** Chunk index (0-based) */
  readonly index: number;
  /** Total number of chunks */
  readonly totalChunks: number;
}
