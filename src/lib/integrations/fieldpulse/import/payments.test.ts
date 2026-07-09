/**
 * Tests for Phase 9 — FieldPulse payments full-history backfill.
 *
 * Covers:
 *  - importPaymentsFromFieldpulse: full walk counts (fetched = items.length,
 *    total = null); deleted-skip; unresolvable-invoice skip (skipped++ not errors++);
 *    created/updated via pre-select; provider="fieldpulse" + providerPaymentId=null;
 *    per-record error containment; once-per-run warn; does NOT write amountPaidCents.
 *  - mapFpPaymentStatus: status mapping for all known + unknown values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { importPaymentsFromFieldpulse, mapFpPaymentStatus } from "./payments";
import type { FieldpulsePayment } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

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
vi.mock("./jobs", () => ({
  parseFpDate: (raw: string | null | undefined) => (raw ? new Date(raw) : null),
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

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
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { onConflictDoUpdate, values };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makePayment(overrides: Partial<FieldpulsePayment> = {}): FieldpulsePayment {
  return {
    id: "80000001",
    invoiceId: "50000001",
    customerId: "20000001",
    paymentDate: "2026-07-03 14:00:00",
    amountCents: 27000,
    method: "check",
    status: "paid",
    deletedAt: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  items: FieldpulsePayment[],
  totalCount: number | null = null,
): FieldpulseClient {
  return {
    listPayments: vi.fn().mockResolvedValue({ items, totalCount }),
  } as unknown as FieldpulseClient;
}

const ORG = "org-test-uuid";

// ── mapFpPaymentStatus unit tests ─────────────────────────────────────────────

describe("mapFpPaymentStatus", () => {
  it("maps 'paid' → 'succeeded'", () => expect(mapFpPaymentStatus("paid")).toBe("succeeded"));
  it("maps 'completed' → 'succeeded'", () => expect(mapFpPaymentStatus("completed")).toBe("succeeded"));
  it("maps 'approved' → 'succeeded'", () => expect(mapFpPaymentStatus("approved")).toBe("succeeded"));
  it("maps 'pending' → 'pending'", () => expect(mapFpPaymentStatus("pending")).toBe("pending"));
  it("maps 'processing' → 'pending'", () => expect(mapFpPaymentStatus("processing")).toBe("pending"));
  it("maps 'failed' → 'failed'", () => expect(mapFpPaymentStatus("failed")).toBe("failed"));
  it("maps 'declined' → 'failed'", () => expect(mapFpPaymentStatus("declined")).toBe("failed"));
  it("maps 'error' → 'failed'", () => expect(mapFpPaymentStatus("error")).toBe("failed"));
  it("maps 'refunded' → 'refunded'", () => expect(mapFpPaymentStatus("refunded")).toBe("refunded"));
  it("maps 'returned' → 'refunded'", () => expect(mapFpPaymentStatus("returned")).toBe("refunded"));
  it("maps unknown → 'pending' (neutral safe default)", () => expect(mapFpPaymentStatus("some_weird")).toBe("pending"));
  it("maps null → 'pending'", () => expect(mapFpPaymentStatus(null)).toBe("pending"));
  it("maps undefined → 'pending'", () => expect(mapFpPaymentStatus(undefined)).toBe("pending"));
});

// ── importPaymentsFromFieldpulse tests ────────────────────────────────────────

describe("importPaymentsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  it("sets fetched = items.length and total = null", async () => {
    const client = makeClient([makePayment()], null);
    const counts = makeCounts();
    // 2 selects: existing fp ids, invoices map
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);
    wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.total).toBeNull();
  });

  it("skips soft-deleted payments and counts them as skipped", async () => {
    const deleted = makePayment({ id: "80000002", deletedAt: "2026-06-01 00:00:00" });
    const active = makePayment({ id: "80000001" });
    const client = makeClient([deleted, active]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);
    wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(1);
  });

  it("skips payments where invoiceId doesn't resolve to a native invoice (skipped++ not errors++)", async () => {
    const payment = makePayment({ invoiceId: "99999999" }); // not in invoice map
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], []]); // empty invoice map

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips payments with no invoiceId (skipped++ not errors++)", async () => {
    const payment = makePayment({ invoiceId: null });
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], []]);

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("counts created for new payments (not in pre-select Set)", async () => {
    const payment = makePayment({ id: "80000001" });
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);
    wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it("counts updated for payments already in pre-select Set (re-run)", async () => {
    const payment = makePayment({ id: "80000001" });
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([
      [{ fieldpulsePaymentId: "80000001" }], // pre-existing
      [{ fpId: "50000001", nativeId: "native-invoice-uuid" }],
    ]);
    wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("sets provider = 'fieldpulse' and providerPaymentId = null", async () => {
    const payment = makePayment({ id: "80000001" });
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);
    const { values } = wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fieldpulse",
        providerPaymentId: null,
        fieldpulsePaymentId: "80000001",
      }),
    );
  });

  it("does NOT touch invoice.amountPaidCents (only payments table mutated)", async () => {
    const payment = makePayment();
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);
    wireInsert();

    await importPaymentsFromFieldpulse(ORG, counts, client);

    // db.insert was only called once (for payments, not invoices)
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("counts errors and continues when insert throws", async () => {
    const p1 = makePayment({ id: "80000001" });
    const p2 = makePayment({ id: "80000002" });
    const client = makeClient([p1, p2]);
    const counts = makeCounts();
    wireSelects([
      [],
      [
        { fpId: "50000001", nativeId: "native-invoice-uuid-1" },
        { fpId: "50000002", nativeId: "native-invoice-uuid-2" },
      ],
    ]);

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

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fpPaymentId: "80000001" }),
      expect.stringContaining("per-record error"),
    );
  });

  it("emits once-per-run warn summary when any errors occurred", async () => {
    const payment = makePayment();
    const client = makeClient([payment]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "50000001", nativeId: "native-invoice-uuid" }]]);

    const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("DB explode"));
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errors: 1, orgId: ORG }),
      expect.stringContaining("per-record errors"),
    );
  });

  it("handles an empty payment list", async () => {
    const client = makeClient([]);
    const counts = makeCounts();
    wireSelects([[], []]);

    await importPaymentsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(0);
    expect(counts.created).toBe(0);
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
