/**
 * Tests for Phase 10 — FieldPulse comments inbound pull.
 *
 * Covers:
 *  - mapFpComment: deleted skip, no-text skip, no-job-ref skip, happy path.
 *  - importCommentsFromFieldpulse: job-resolution, skip-unresolved, idempotent
 *    key (re-run no-op), per-record error containment.
 *
 * Uses sanitized fixtures (fake PII only).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapFpComment, importCommentsFromFieldpulse } from "./comments";
import type { FieldpulseComment } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeComment(overrides: Partial<FieldpulseComment> = {}): FieldpulseComment {
  return {
    id: "30001001",
    text: "Unit is running again after thermostat replacement.",
    authorId: "50001001",
    commentableId: "10000001", // FP job id
    commentableType: "BaseJob",
    createdAt: "2026-06-15 14:30:00",
    isVisibleInCustomerPortal: false,
    deletedAt: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  comments: FieldpulseComment[],
  totalCount: number | null = null,
): FieldpulseClient {
  return {
    listComments: vi.fn().mockResolvedValue({ items: comments, totalCount }),
  } as unknown as FieldpulseClient;
}

// ── mapFpComment ──────────────────────────────────────────────────────────────

describe("mapFpComment", () => {
  it("maps a valid comment correctly", () => {
    const result = mapFpComment(makeComment());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comment.fpCommentId).toBe("30001001");
    expect(result.comment.fpJobId).toBe("10000001");
    expect(result.comment.content).toBe(
      "[FieldPulse job #10000001] Unit is running again after thermostat replacement.",
    );
  });

  it("skips deleted comments", () => {
    const result = mapFpComment(makeComment({ deletedAt: "2026-06-15 15:00:00" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("deleted");
  });

  it("skips comments with no text", () => {
    const result = mapFpComment(makeComment({ text: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-text");
  });

  it("skips comments with empty text", () => {
    const result = mapFpComment(makeComment({ text: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-text");
  });

  it("skips comments with no commentableId", () => {
    const result = mapFpComment(makeComment({ commentableId: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-job-ref");
  });
});

// ── importCommentsFromFieldpulse ──────────────────────────────────────────────

const ORG = "org-test-uuid";

function wireSelect(resolveWith: unknown[]) {
  const where = vi.fn().mockResolvedValue(resolveWith);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  return { from, where };
}

function wireInsert(resolveWith: unknown[] = [{ id: "note-1" }]) {
  const returning = vi.fn().mockResolvedValue(resolveWith);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoNothing, returning };
}

describe("importCommentsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips deleted comments", async () => {
    const client = makeClient([makeComment({ deletedAt: "2026-06-15 15:00:00" })]);
    const counts = makeCounts();
    wireSelect([]);

    await importCommentsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips comments whose FP job is not imported", async () => {
    const client = makeClient([makeComment()]);
    const counts = makeCounts();
    // Pre-select returns empty: no imported jobs.
    wireSelect([]);

    await importCommentsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unresolvedJobCount: 1 }),
      expect.stringContaining("skipped comments"),
    );
  });

  it("creates a customer_notes row for a resolved comment", async () => {
    const client = makeClient([makeComment()]);
    const counts = makeCounts();
    // Pre-select: job "10000001" → customer "cust-1".
    wireSelect([{ fieldpulseJobId: "10000001", customerId: "cust-1" }]);
    const { values } = wireInsert([{ id: "note-new" }]);

    await importCommentsFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.skipped).toBe(0);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        customerId: "cust-1",
        authorId: null,
        content: "[FieldPulse job #10000001] Unit is running again after thermostat replacement.",
        fieldpulseCommentId: "30001001",
      }),
    );
  });

  it("idempotent key: counts skipped on re-run (onConflictDoNothing no-op)", async () => {
    const client = makeClient([makeComment()]);
    const counts = makeCounts();
    wireSelect([{ fieldpulseJobId: "10000001", customerId: "cust-1" }]);
    wireInsert([]); // no row returned → already exists

    await importCommentsFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(0);
    expect(counts.skipped).toBe(1);
  });

  it("per-record errors are contained", async () => {
    const c1 = makeComment({ id: "30001001" });
    const c2 = makeComment({ id: "30001002" });
    const client = makeClient([c1, c2]);
    const counts = makeCounts();
    wireSelect([{ fieldpulseJobId: "10000001", customerId: "cust-1" }]);

    // First insert throws; second succeeds.
    const ret1 = vi.fn().mockRejectedValueOnce(new Error("DB explode"));
    const ret2 = vi.fn().mockResolvedValue([{ id: "note-2" }]);
    const noConflict1 = vi.fn().mockReturnValue({ returning: ret1 });
    const noConflict2 = vi.fn().mockReturnValue({ returning: ret2 });
    const vals1 = vi.fn().mockReturnValue({ onConflictDoNothing: noConflict1 });
    const vals2 = vi.fn().mockReturnValue({ onConflictDoNothing: noConflict2 });
    vi.mocked(db.insert)
      .mockReturnValueOnce({ values: vals1 } as never)
      .mockReturnValueOnce({ values: vals2 } as never);

    await importCommentsFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
