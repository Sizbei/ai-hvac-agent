import { describe, it, expect, vi } from "vitest";
import { classifyWriteError } from "./invoice-client-errors";

describe("classifyWriteError", () => {
  it.each<[string, number | null, string | null, { storedStatus?: number } | undefined, string]>([
    ["network error", null, null, undefined, "retry_same_key_after_refetch"],
    ["500 without a code", 500, null, undefined, "retry_same_key_after_refetch"],
    ["500 INTERNAL_ERROR", 500, "INTERNAL_ERROR", undefined, "retry_same_key_after_refetch"],
    ["503 unstored code", 503, "SERVICE_UNAVAILABLE", undefined, "retry_same_key_after_refetch"],
    ["500 SEND_FAILED (stored)", 500, "SEND_FAILED", undefined, "spent_new_key"],
    ["409 IN_PROGRESS", 409, "IN_PROGRESS", undefined, "wait_then_refetch"],
    ["409 STALE", 409, "STALE", undefined, "show_message_refetch"],
    ["409 INVOICE_LOCKED (stored, but a message)", 409, "INVOICE_LOCKED", undefined, "show_message_refetch"],
    ["409 INVOICE_VOIDED (stored, but a message)", 409, "INVOICE_VOIDED", undefined, "show_message_refetch"],
    ["422 EXCEEDS_BALANCE", 422, "EXCEEDS_BALANCE", undefined, "refetch_new_key"],
    ["422 IDEMPOTENCY_KEY_REUSED storedStatus 201", 422, "IDEMPOTENCY_KEY_REUSED", { storedStatus: 201 }, "already_saved_refetch"],
    ["422 IDEMPOTENCY_KEY_REUSED storedStatus 200", 422, "IDEMPOTENCY_KEY_REUSED", { storedStatus: 200 }, "already_saved_refetch"],
    ["422 IDEMPOTENCY_KEY_REUSED storedStatus 409", 422, "IDEMPOTENCY_KEY_REUSED", { storedStatus: 409 }, "spent_new_key"],
    ["422 IDEMPOTENCY_KEY_REUSED storedStatus 299", 422, "IDEMPOTENCY_KEY_REUSED", { storedStatus: 299 }, "already_saved_refetch"],
    ["422 IDEMPOTENCY_KEY_REUSED storedStatus 300", 422, "IDEMPOTENCY_KEY_REUSED", { storedStatus: 300 }, "spent_new_key"],
    ["500 with a stored code other than SEND_FAILED", 500, "VALIDATION_ERROR", undefined, "spent_new_key"],
    ["502 NO_LINES (stored)", 502, "NO_LINES", undefined, "spent_new_key"],
    ["422 IDEMPOTENCY_KEY_REUSED no details", 422, "IDEMPOTENCY_KEY_REUSED", undefined, "spent_new_key"],
    ["409 ALREADY_BILLED (stored)", 409, "ALREADY_BILLED", undefined, "spent_new_key"],
    ["422 NO_LINES (stored)", 422, "NO_LINES", undefined, "spent_new_key"],
    ["400 VALIDATION_ERROR (stored)", 400, "VALIDATION_ERROR", undefined, "spent_new_key"],
    ["403 NOT_LEAD", 403, "NOT_LEAD", undefined, "show_message_refetch"],
    ["429 COOLDOWN", 429, "COOLDOWN", undefined, "show_message_refetch"],
    ["404 NOT_FOUND", 404, "NOT_FOUND", undefined, "show_message_refetch"],
    ["4xx without a code", 400, null, undefined, "show_message_refetch"],
    ["2xx is a success", 201, null, undefined, "success_refetch"],
  ])("%s", (_name, status, code, details, expected) => {
    expect(classifyWriteError(status, code, details)).toBe(expected);
  });

  it("FROM_ESTIMATE and JOB_CLOSED show their message and refetch (M3c)", () => {
    expect(classifyWriteError(409, "FROM_ESTIMATE")).toBe("show_message_refetch");
    expect(classifyWriteError(409, "JOB_CLOSED")).toBe("show_message_refetch");
  });

  it("FROM_ESTIMATE and JOB_CLOSED are message conflicts in their own right, not by falling through as unstored", async () => {
    // Pretend both were stored: only their MESSAGE_CONFLICTS entry keeps them a message.
    vi.resetModules();
    vi.doMock("@/lib/http/idempotency-codes", () => ({ STORED_CODES: new Set(["FROM_ESTIMATE", "JOB_CLOSED", "PROBE_STORED"]) }));
    try {
      const { classifyWriteError: fresh } = await import("./invoice-client-errors");
      expect(fresh(409, "FROM_ESTIMATE")).toBe("show_message_refetch");
      expect(fresh(409, "JOB_CLOSED")).toBe("show_message_refetch");
      expect(fresh(409, "PROBE_STORED")).toBe("spent_new_key"); // the mock is live
    } finally {
      vi.doUnmock("@/lib/http/idempotency-codes");
      vi.resetModules();
    }
  });
});
