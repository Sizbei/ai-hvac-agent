/**
 * Tests for Phase 9 — FieldPulse estimates full-history backfill.
 *
 * Covers:
 *  - importEstimatesFromFieldpulse: full walk counts (fetched = items.length,
 *    total = null); deleted-skip classification; created/updated via pre-select;
 *    customer + job resolution; per-record error containment; once-per-run warn.
 *  - mapFpEstimateStatus: status mapping for all known + unknown values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { importEstimatesFromFieldpulse, mapFpEstimateStatus } from "./estimates";
import type { FieldpulseEstimate } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Queue-based db mock to handle multiple sequential select calls.
const selectQueue: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// Wire chainable Drizzle mocks: select returns queued rows; insert resolves.
function wireSelects(results: unknown[][]) {
  selectQueue.length = 0;
  results.forEach((r) => selectQueue.push(r));

  vi.mocked(db.select).mockImplementation(() => {
    const rows = selectQueue.shift() ?? [];
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    return { from } as never;
  });
}

function wireInsert() {
  const conflictUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate: conflictUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { conflictUpdate, values };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeEstimate(overrides: Partial<FieldpulseEstimate> = {}): FieldpulseEstimate {
  return {
    id: "70000001",
    customerId: "20000001",
    jobId: "10000001",
    status: "2",
    subtotalCents: 25000,
    taxCents: 2000,
    totalCents: 27000,
    notes: "Replace capacitor",
    dueDate: "2026-08-01",
    invoicedDate: null,
    createdAt: "2026-07-01 08:00:00",
    deletedAt: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  items: FieldpulseEstimate[],
  totalCount: number | null = null,
): FieldpulseClient {
  return {
    listEstimates: vi.fn().mockResolvedValue({ items, totalCount }),
  } as unknown as FieldpulseClient;
}

const ORG = "org-test-uuid";

// ── mapFpEstimateStatus unit tests ────────────────────────────────────────────

describe("mapFpEstimateStatus", () => {
  it("maps '1' → 'open'", () => expect(mapFpEstimateStatus("1")).toBe("open"));
  it("maps 'draft' → 'open'", () => expect(mapFpEstimateStatus("draft")).toBe("open"));
  it("maps 'open' → 'open'", () => expect(mapFpEstimateStatus("open")).toBe("open"));
  it("maps '2' → 'sold'", () => expect(mapFpEstimateStatus("2")).toBe("sold"));
  it("maps 'approved' → 'sold'", () => expect(mapFpEstimateStatus("approved")).toBe("sold"));
  it("maps 'sold' → 'sold'", () => expect(mapFpEstimateStatus("sold")).toBe("sold"));
  it("maps 'accepted' → 'sold'", () => expect(mapFpEstimateStatus("accepted")).toBe("sold"));
  it("maps '3' → 'dismissed'", () => expect(mapFpEstimateStatus("3")).toBe("dismissed"));
  it("maps 'void' → 'dismissed'", () => expect(mapFpEstimateStatus("void")).toBe("dismissed"));
  it("maps 'declined' → 'dismissed'", () => expect(mapFpEstimateStatus("declined")).toBe("dismissed"));
  it("maps 'dismissed' → 'dismissed'", () => expect(mapFpEstimateStatus("dismissed")).toBe("dismissed"));
  it("maps 'rejected' → 'dismissed'", () => expect(mapFpEstimateStatus("rejected")).toBe("dismissed"));
  it("maps '4' → 'expired'", () => expect(mapFpEstimateStatus("4")).toBe("expired"));
  it("maps 'expired' → 'expired'", () => expect(mapFpEstimateStatus("expired")).toBe("expired"));
  it("maps unknown string → 'open' (safe default)", () => expect(mapFpEstimateStatus("some_weird_status")).toBe("open"));
  it("maps null → 'open'", () => expect(mapFpEstimateStatus(null)).toBe("open"));
  it("maps undefined → 'open'", () => expect(mapFpEstimateStatus(undefined)).toBe("open"));
});

// ── importEstimatesFromFieldpulse tests ───────────────────────────────────────

describe("importEstimatesFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  it("sets fetched = items.length and total = null (totalCount always null on /estimates)", async () => {
    const client = makeClient([makeEstimate()], null);
    const counts = makeCounts();
    // 3 selects: existing fp ids, customers, service_requests
    wireSelects([[], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.total).toBeNull();
  });

  it("skips soft-deleted estimates and counts them as skipped", async () => {
    const deleted = makeEstimate({ id: "70000002", deletedAt: "2026-06-01 00:00:00" });
    const active = makeEstimate({ id: "70000001" });
    const client = makeClient([deleted, active]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(1);
  });

  it("resolves customerId from fieldpulseCustomerId pre-select", async () => {
    const est = makeEstimate({ customerId: "20000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    // existing fp ids (empty), customers (has mapping), service_requests (empty)
    wireSelects([
      [],
      [{ fpId: "20000001", nativeId: "native-customer-uuid" }],
      [],
    ]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("resolves serviceRequestId from fieldpulseJobId pre-select", async () => {
    const est = makeEstimate({ jobId: "10000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([
      [],
      [],
      [{ fpId: "10000001", nativeId: "native-sr-uuid" }],
    ]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("counts created for new estimates (not in pre-select Set)", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it("counts updated for estimates already in pre-select Set (re-run)", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    // existing fp ids has this estimate already
    wireSelects([[{ fieldpulseEstimateId: "70000001" }], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("counts errors and continues when insert throws", async () => {
    const est1 = makeEstimate({ id: "70000001" });
    const est2 = makeEstimate({ id: "70000002" });
    const client = makeClient([est1, est2]);
    const counts = makeCounts();
    wireSelects([[], [], []]);

    let callCount = 0;
    vi.mocked(db.insert).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("DB explode"));
        const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
        return { values } as never;
      }
      const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      return { values } as never;
    });

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fpEstimateId: "70000001" }),
      expect.stringContaining("per-record error"),
    );
  });

  it("emits once-per-run warn summary when any errors occurred", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);

    const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("DB explode"));
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errors: 1, orgId: ORG }),
      expect.stringContaining("per-record errors"),
    );
  });

  it("does not emit error summary when there are no errors", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("mirrors FP createdAt as parsed UTC date in inserted estimate", async () => {
    const est = makeEstimate({ id: "70000001", createdAt: "2026-07-01 08:00:00" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    const { values: valuesMock } = wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    // Verify that values() was called and createdAt was set to the parsed date
    const calledWith = valuesMock.mock.calls[0]?.[0];
    expect(calledWith?.createdAt).toEqual(new Date("2026-07-01T08:00:00Z"));
  });

  it("handles an empty estimate list", async () => {
    const client = makeClient([]);
    const counts = makeCounts();
    wireSelects([[], [], []]);

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(0);
    expect(counts.created).toBe(0);
    expect(counts.errors).toBe(0);
  });

  it("logs unknown statuses once at end", async () => {
    const est = makeEstimate({ id: "70000001", status: "weird_status" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    wireInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unknownStatuses: { weird_status: 1 } }),
      expect.stringContaining("unknown FP status codes"),
    );
  });
});
