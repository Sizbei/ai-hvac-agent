/**
 * Pure classifier for a failed technician money write (spec §7.6). The
 * spent-vs-retry decision uses the same `STORED_CODES` as the server (§4): a
 * stored code means the key is spent.
 */
import { STORED_CODES } from "@/lib/http/idempotency-codes";
import type { WriteOutcome } from "./invoice-key-state";

export type { WriteOutcome };

const MESSAGE_CONFLICTS: ReadonlySet<string> = new Set(["STALE", "INVOICE_LOCKED", "INVOICE_VOIDED"]);

const isStored = (code: string | null): boolean => code !== null && STORED_CODES.has(code);

/** `status` null = the request never got an answer (network error). */
export function classifyWriteError(
  status: number | null,
  code: string | null,
  details?: { storedStatus?: number },
): WriteOutcome {
  if (status !== null && status >= 200 && status < 300) return "success_refetch";
  if (status === null || status >= 500) {
    // A stored 5xx (pay-link SEND_FAILED) is a definitive answer.
    return isStored(code) ? "spent_new_key" : "retry_same_key_after_refetch";
  }
  if (status === 409 && code === "IN_PROGRESS") return "wait_then_refetch";
  if (status === 409 && code !== null && MESSAGE_CONFLICTS.has(code)) return "show_message_refetch";
  if (status === 422 && code === "EXCEEDS_BALANCE") return "refetch_new_key";
  if (status === 422 && code === "IDEMPOTENCY_KEY_REUSED") {
    const stored = details?.storedStatus;
    return stored !== undefined && stored >= 200 && stored < 300 ? "already_saved_refetch" : "spent_new_key";
  }
  return isStored(code) ? "spent_new_key" : "show_message_refetch";
}
