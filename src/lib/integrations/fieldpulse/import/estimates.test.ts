/**
 * Tests for Phase 9 — FieldPulse estimates full-history backfill.
 *
 * Covers:
 *  - importEstimatesFromFieldpulse: full walk counts (fetched = items.length,
 *    total = null); deleted-skip classification; created/updated via pre-select;
 *    customer + job resolution; per-record error containment; once-per-run warn.
 *  - mapFpEstimateStatus: status mapping for all known + unknown values.
 *  - Phase 6 additions: line item synthetic option + upsert; status name enrichment
 *    via getEstimate; error containment on enrichment failure.
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
    update: vi.fn(),
    delete: vi.fn(),
    batch: vi.fn(),
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

/**
 * Wire the insert mock. The upsert chain is:
 *   insert(estimates).values({}).onConflictDoUpdate({}).returning({}) → [{ id }]
 * Option insert chain is:
 *   insert(estimateOptions).values({}).returning({}) → [{ id }]
 * Line item insert chain (inside db.batch):
 *   insert(estimateLineItems).values([]) → (consumed by batch mock, not awaited directly)
 *
 * We use a call-count approach so the first insert (estimates) returns the
 * upsert chain with returning, subsequent inserts return a simpler chain.
 */
function wireInsert(estimateNativeId = "native-estimate-uuid", optionNativeId = "native-option-uuid") {
  let callCount = 0;
  vi.mocked(db.insert).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // estimates upsert: .values({}).onConflictDoUpdate({}).returning({}) → [{ id }]
      const returning = vi.fn().mockResolvedValue([{ id: estimateNativeId }]);
      const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      return { values } as never;
    }
    if (callCount === 2) {
      // estimateOptions insert: .values({}).returning({}) → [{ id }]
      const returning = vi.fn().mockResolvedValue([{ id: optionNativeId }]);
      const values = vi.fn().mockReturnValue({ returning });
      return { values } as never;
    }
    // estimateLineItems insert (inside batch): .values([]) — batch consumes it
    const values = vi.fn().mockReturnValue({});
    return { values } as never;
  });

  vi.mocked(db.delete).mockImplementation(() => {
    const where = vi.fn().mockReturnValue({});
    return { where } as never;
  });

  vi.mocked(db.batch).mockResolvedValue([] as never);

  return { callCount: () => callCount };
}

/**
 * Wire insert for the simple case (no line items): only the estimates upsert
 * insert is called. Returns helpers to inspect the values call.
 */
function wireSimpleInsert(estimateNativeId = "native-estimate-uuid") {
  const returning = vi.fn().mockResolvedValue([{ id: estimateNativeId }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  vi.mocked(db.batch).mockResolvedValue([] as never);
  return { returning, onConflictDoUpdate, values };
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
  getEstimateResult: FieldpulseEstimate | null = null,
): FieldpulseClient {
  return {
    listEstimates: vi.fn().mockResolvedValue({ items, totalCount }),
    getEstimate: vi.fn().mockResolvedValue(getEstimateResult),
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
    wireSimpleInsert();

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
    wireSimpleInsert();

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
    wireSimpleInsert();

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
    wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("counts created for new estimates (not in pre-select Set)", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    wireSimpleInsert();

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
    wireSimpleInsert();

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
        // First estimate insert — throw
        const returning = vi.fn().mockRejectedValue(new Error("DB explode"));
        const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
        const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
        return { values } as never;
      }
      // Second estimate insert — succeed
      const returning = vi.fn().mockResolvedValue([{ id: "native-uuid-2" }]);
      const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      return { values } as never;
    });
    vi.mocked(db.batch).mockResolvedValue([] as never);

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

    const returning = vi.fn().mockRejectedValue(new Error("DB explode"));
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    vi.mocked(db.batch).mockResolvedValue([] as never);

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
    wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("mirrors FP createdAt as parsed UTC date in inserted estimate", async () => {
    const est = makeEstimate({ id: "70000001", createdAt: "2026-07-01 08:00:00" });
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    const { values: valuesMock } = wireSimpleInsert();

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
    wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unknownStatuses: { weird_status: 1 } }),
      expect.stringContaining("unknown FP status codes"),
    );
  });

  // ── Phase 6: line items ───────────────────────────────────────────────────

  it("creates a synthetic FieldPulse option and inserts line items when estimate has line_items", async () => {
    const est = makeEstimate({
      id: "70000003",
      lineItems: [
        { name: "Capacitor Replacement", quantity: 2, unitPriceCents: 12500, unitCostCents: 6000 },
        { name: "Annual Tune-Up", quantity: 1, unitPriceCents: 23500, unitCostCents: 8000 },
      ],
    });
    const client = makeClient([est]);
    const counts = makeCounts();
    // 3 pre-selects + 1 option existence check (returns empty = no existing option)
    wireSelects([[], [], [], []]);
    wireInsert("native-est-uuid", "native-opt-uuid");

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
    // db.insert called for estimates + estimateOptions + estimateLineItems (inside batch)
    expect(db.insert).toHaveBeenCalledTimes(3);
    // db.batch for delete + line item insert
    expect(db.batch).toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalled();
  });

  it("reuses existing synthetic option on resync (idempotency)", async () => {
    const est = makeEstimate({
      id: "70000003",
      lineItems: [
        { name: "Capacitor Replacement", quantity: 1, unitPriceCents: 12500, unitCostCents: 6000 },
      ],
    });
    const client = makeClient([est]);
    const counts = makeCounts();
    // 3 pre-selects + option existence check returns existing option
    wireSelects([[], [], [], [{ id: "existing-option-uuid" }]]);
    // Only the estimates insert is called (option already exists)
    const returning = vi.fn().mockResolvedValue([{ id: "native-est-uuid" }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    vi.mocked(db.delete).mockImplementation(() => ({ where: vi.fn().mockReturnValue({}) } as never));
    vi.mocked(db.batch).mockResolvedValue([] as never);
    // option UPDATE (totals refresh) on the reuse path
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as never);

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    // estimates insert + estimateLineItems insert inside batch (no option insert — reused)
    expect(db.insert).toHaveBeenCalledTimes(2);
    // But batch (delete + line item insert) is still called
    expect(db.batch).toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalled();
    // totals refresh update must have been called
    expect(db.update).toHaveBeenCalled();
  });

  it("re-import with changed totals updates option row (M3 fix)", async () => {
    const est = makeEstimate({
      id: "70000003",
      subtotalCents: 50000,
      taxCents: 4000,
      totalCents: 54000,
      lineItems: [
        { name: "New Part", quantity: 1, unitPriceCents: 50000, unitCostCents: 20000 },
      ],
    });
    const client = makeClient([est]);
    const counts = makeCounts();
    // 3 pre-selects + option existence check returns existing option
    wireSelects([[], [], [], [{ id: "existing-option-uuid" }]]);
    const returning = vi.fn().mockResolvedValue([{ id: "native-est-uuid" }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    vi.mocked(db.delete).mockImplementation(() => ({ where: vi.fn().mockReturnValue({}) } as never));
    vi.mocked(db.batch).mockResolvedValue([] as never);

    let capturedUpdateSet: Record<string, unknown> | undefined;
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedUpdateSet = s;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    } as never);

    await importEstimatesFromFieldpulse(ORG, counts, client);

    // The option UPDATE must carry the fresh totals from the FP response.
    expect(capturedUpdateSet).toMatchObject({
      subtotalCents: 50000,
      taxCents: 4000,
      totalCents: 54000,
    });
  });

  // ── Phase 6: status name enrichment ──────────────────────────────────────

  it("stores fieldpulseStatusName from getEstimate customStatus", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = makeClient(
      [est],
      null,
      makeEstimate({ id: "70000001", customStatus: "Sent" }),
    );
    const counts = makeCounts();
    wireSelects([[], [], []]);
    const { values: valuesMock, onConflictDoUpdate } = wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    // fieldpulseStatusName should be "Sent" in the insert values
    const insertedValues = valuesMock.mock.calls[0]?.[0];
    expect(insertedValues?.fieldpulseStatusName).toBe("Sent");
    // And in the onConflictDoUpdate set
    const updateSet = onConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(updateSet?.fieldpulseStatusName).toBe("Sent");
  });

  it("continues with null fieldpulseStatusName when getEstimate throws", async () => {
    const est = makeEstimate({ id: "70000001" });
    const client = {
      listEstimates: vi.fn().mockResolvedValue({ items: [est], totalCount: null }),
      getEstimate: vi.fn().mockRejectedValue(new Error("Network failure")),
    } as unknown as FieldpulseClient;
    const counts = makeCounts();
    wireSelects([[], [], []]);
    const { values: valuesMock } = wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    // Record is still created
    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
    // fieldpulseStatusName defaults to null
    const insertedValues = valuesMock.mock.calls[0]?.[0];
    expect(insertedValues?.fieldpulseStatusName).toBeNull();
    // A warn is logged for the enrichment failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fpEstimateId: "70000001" }),
      expect.stringContaining("per-id enrichment failed"),
    );
  });
});


// ── Spillover integration: est._raw → buildFpSpillover → fieldpulseData ────────

describe("importEstimatesFromFieldpulse — fieldpulseData spillover from raw payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures unpromoted safe raw fields and excludes promoted/denied ones", async () => {
    const est = makeEstimate({
      lineItems: [], // no line items → simple insert path
      _raw: {
        // Unpromoted, non-denied primitive — should SURVIVE (denylist mode).
        discount_type: "percent",
        // Promoted fields — excluded (already typed columns).
        id: "70000001",
        customer_id: "20000001",
        status: "2",
        subtotal: "250.00",
        total: "270.00",
        due_date: "2026-08-01",
        name: "HVAC Repair Quote",
        // Globally denied — excluded (qbo_ prefix / estimate_display_ prefix).
        qbo_estimate_id: "qb-est-1",
        estimate_display_settings: "compact",
      },
    });
    const client = makeClient([est]);
    const counts = makeCounts();
    // Pre-selects: existingFpIds, customerMap, jobMap.
    wireSelects([[], [], []]);
    const { values } = wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldpulseData: { discount_type: "percent" },
      }),
    );
  });

  it("fieldpulseData is null when _raw is absent (fallback to {})", async () => {
    const est = makeEstimate({ lineItems: [] }); // no _raw
    const client = makeClient([est]);
    const counts = makeCounts();
    wireSelects([[], [], []]);
    const { values } = wireSimpleInsert();

    await importEstimatesFromFieldpulse(ORG, counts, client);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ fieldpulseData: null }),
    );
  });
});
