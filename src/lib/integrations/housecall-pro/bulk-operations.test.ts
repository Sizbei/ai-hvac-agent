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
