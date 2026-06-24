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
 * This module is being built in slices: this slice ships input validation; the
 * bounded-worker-pool executor + admin endpoint follow.
 */
import type { BulkJobOperation } from "./bulk-types";

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
