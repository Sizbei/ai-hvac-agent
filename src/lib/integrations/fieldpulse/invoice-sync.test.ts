/**
 * Tests for the FieldPulse invoice pull mirror (invoice-sync.ts).
 *
 * Covers:
 *  - upsertInvoiceRecord — fieldpulseData spillover: invoice._raw (the raw FP
 *    API payload threaded through toInvoice) is fed to buildFpSpillover in
 *    denylist mode; unpromoted safe primitives survive, promoted/denied fields
 *    are excluded, and absence of _raw yields null.
 *
 * The import/invoices.test.ts suite mocks upsertInvoiceRecord out entirely, so
 * the spillover wiring is asserted here at the real DB-write boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FieldpulseInvoice } from "./types";

// ── Module mocks ──────────────────────────────────────────────────────────────

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
// upsertInvoiceRecord itself never calls the client; mock the module so this
// suite doesn't drag in the live client/config import chain.
vi.mock("./client", () => ({
  getFieldpulseClient: vi.fn(),
}));

import { db } from "@/lib/db";
import { upsertInvoiceRecord } from "./invoice-sync";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const ORG = "org-test-uuid";

/**
 * jobId/customerId are null so upsertInvoiceRecord skips the link-resolution
 * selects AND the post-write syncInvoiceStatus call — the only select is the
 * existing-invoice lookup and the only writes are the insert + audit batch.
 */
function makeInvoice(overrides: Partial<FieldpulseInvoice> = {}): FieldpulseInvoice {
  return {
    id: "60000001",
    jobId: null,
    customerId: null,
    status: "3",
    totalCents: 27000,
    amountPaidCents: 27000,
    amountUnpaidCents: 0,
    dueDate: null,
    paidAt: null,
    createdAt: "2026-07-01 08:00:00",
    deletedAt: null,
    lineItems: [],
    ...overrides,
  };
}

/** Wire the single SELECT (existing invoice lookup) to return no rows. */
function wireSelectNoExisting() {
  const where = vi.fn().mockResolvedValue([]);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

/**
 * Wire inserts: call 1 is the invoices insert
 * (.values().onConflictDoNothing().returning() → [{ id }]); later calls are
 * batch builders (auditLog) whose chains are consumed by db.batch.
 */
function wireInsert(nativeId = "native-invoice-uuid") {
  let invoiceValues: ReturnType<typeof vi.fn> | null = null;
  let callCount = 0;
  vi.mocked(db.insert).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      const returning = vi.fn().mockResolvedValue([{ id: nativeId }]);
      const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
      invoiceValues = vi.fn().mockReturnValue({ onConflictDoNothing });
      return { values: invoiceValues } as never;
    }
    const values = vi.fn().mockReturnValue({});
    return { values } as never;
  });
  vi.mocked(db.batch).mockResolvedValue([] as never);
  return { getInvoiceValues: () => invoiceValues };
}

// ── Spillover integration: invoice._raw → buildFpSpillover → fieldpulseData ────

describe("upsertInvoiceRecord — fieldpulseData spillover from raw payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures unpromoted safe raw fields and excludes promoted/denied ones", async () => {
    const invoice = makeInvoice({
      _raw: {
        // Unpromoted, non-denied primitive — should SURVIVE (denylist mode).
        payment_terms: "net30",
        // Promoted fields — excluded (already typed columns).
        id: "60000001",
        customer_id: "20000001",
        status: 3,
        total: "270.00",
        amount_paid: "270.00",
        amount_unpaid: "0.00",
        due_date: "2026-08-01",
        // Globally denied — excluded (qbo_ / invoice_show_ prefixes).
        qbo_invoice_id: "qb-inv-1",
        invoice_show_pricing: true,
      },
    });
    wireSelectNoExisting();
    const { getInvoiceValues } = wireInsert();

    const outcome = await upsertInvoiceRecord(ORG, invoice);

    expect(outcome).toBe("created");
    expect(getInvoiceValues()).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldpulseData: { payment_terms: "net30" },
      }),
    );
  });

  it("fieldpulseData is null when _raw is absent (fallback to {})", async () => {
    const invoice = makeInvoice(); // no _raw
    wireSelectNoExisting();
    const { getInvoiceValues } = wireInsert();

    const outcome = await upsertInvoiceRecord(ORG, invoice);

    expect(outcome).toBe("created");
    expect(getInvoiceValues()).toHaveBeenCalledWith(
      expect.objectContaining({ fieldpulseData: null }),
    );
  });
});
