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
import { upsertInvoiceRecord, pullOpenFieldpulseInvoices } from "./invoice-sync";
import { getFieldpulseClient } from "./client";

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

// ── Re-linking an already-mirrored invoice ────────────────────────────────────

/**
 * The UPDATE branch used to refresh money but never the customer/service-request
 * FKs. An invoice first synced BEFORE its customer was imported therefore stayed
 * orphaned forever — re-running the import could not repair it. In the dev
 * mirror that stranded 11 open invoices holding real AR with no customer
 * profile and no reminder path.
 *
 * The fix must be asymmetric: re-link when we resolved someone, never un-link
 * when we didn't (spreading a null would erase a good link on any sync that
 * failed to resolve).
 */
describe("upsertInvoiceRecord — re-links an existing invoice without un-linking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  /** Captures the .set() payload the UPDATE branch builds. */
  function wireExistingInvoice(): { getSet: () => Record<string, unknown> | null } {
    let captured: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockReturnValue({
      set: (v: Record<string, unknown>) => {
        captured = v;
        return { where: vi.fn() };
      },
    } as never);
    return { getSet: () => captured };
  }

  it("writes customerId into the update when the customer resolves", async () => {
    // Order matters: link resolution runs BEFORE the existing-invoice lookup.
    // select #1 = customer lookup (resolves), #2 = existing invoice.
    const results = [[{ id: "cust-1" }], [{ id: "existing-invoice", state: "open" }]];
    let call = 0;
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: () => ({
            where: () => {
              const r = results[call] ?? [];
              call++;
              return Object.assign(Promise.resolve(r), {
                limit: () => Promise.resolve(r),
              });
            },
          }),
        }) as never,
    );
    const { getSet } = wireExistingInvoice();

    await upsertInvoiceRecord(ORG, makeInvoice({ customerId: "17431130" }));

    const set = getSet();
    expect(set).not.toBeNull();
    expect(set?.customerId).toBe("cust-1");
  });

  it("omits customerId entirely when the customer does NOT resolve — never nulls a good link", async () => {
    // select #1 = customer lookup (NO match), #2 = existing invoice.
    const results = [[], [{ id: "existing-invoice", state: "open" }]];
    let call = 0;
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: () => ({
            where: () => {
              const r = results[call] ?? [];
              call++;
              return Object.assign(Promise.resolve(r), {
                limit: () => Promise.resolve(r),
              });
            },
          }),
        }) as never,
    );
    const { getSet } = wireExistingInvoice();

    await upsertInvoiceRecord(ORG, makeInvoice({ customerId: "99999999" }));

    const set = getSet();
    expect(set).not.toBeNull();
    // Absent, not null — a null would overwrite an existing good link.
    expect(set && "customerId" in set).toBe(false);
  });
});

/**
 * Strict fp-id resolution is not enough. A customer merged away by contact
 * dedupe holds no row under its own fp id, so every invoice pointing at it
 * resolved to null and was written orphaned — invisible to collections, with no
 * reminder path and no AR owner. Live count on the dev mirror: 506 orphaned FP
 * invoices, 93 unpaid.
 *
 * The healer is the second chance. These assert it is actually consulted, only
 * on a miss, and that its answer reaches the row.
 */
describe("upsertInvoiceRecord — heals a customer link the strict lookup missed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  /** select #1 = customer lookup, #2 = existing invoice. */
  function wireSelects(customerRows: unknown[], invoiceRows: unknown[]) {
    const results = [customerRows, invoiceRows];
    let call = 0;
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: () => ({
            where: () => {
              const r = results[call] ?? [];
              call++;
              return Object.assign(Promise.resolve(r), {
                limit: () => Promise.resolve(r),
              });
            },
          }),
        }) as never,
    );
  }

  it("uses the healed customer id when the strict fp-id lookup finds nothing", async () => {
    wireSelects([], []); // customer misses, invoice is new → INSERT branch
    const { getInvoiceValues } = wireInsert();
    const heal = vi.fn().mockResolvedValue("healed-customer-id");

    await upsertInvoiceRecord(ORG, makeInvoice({ customerId: "17492296" }), heal);

    expect(heal).toHaveBeenCalledWith("17492296");
    const values = getInvoiceValues();
    expect(values).not.toBeNull();
    expect(values?.mock.calls[0]?.[0]?.customerId).toBe("healed-customer-id");
  });

  it("does NOT call the healer when the strict lookup already resolved", async () => {
    wireSelects([{ id: "cust-1" }], []);
    const { getInvoiceValues } = wireInsert();
    const heal = vi.fn();

    await upsertInvoiceRecord(ORG, makeInvoice({ customerId: "17431130" }), heal);

    // A hit must not cost a FieldPulse round-trip.
    expect(heal).not.toHaveBeenCalled();
    expect(getInvoiceValues()?.mock.calls[0]?.[0]?.customerId).toBe("cust-1");
  });

  it("leaves the link null when the healer also comes up empty (hard-deleted in FP)", async () => {
    wireSelects([], []);
    const { getInvoiceValues } = wireInsert();
    const heal = vi.fn().mockResolvedValue(null);

    await upsertInvoiceRecord(ORG, makeInvoice({ customerId: "99999999" }), heal);

    // Honest null beats a fabricated link — you cannot collect from a customer
    // that no longer exists, and inventing one would only hide that.
    expect(getInvoiceValues()?.mock.calls[0]?.[0]?.customerId).toBeNull();
  });
});

/**
 * The invoices-phase backfill cannot count unlinked invoices from the database
 * afterward — an unlinked mirrored invoice carries no evidence of which FP
 * customer it belonged to. So upsertInvoiceRecord reports it live via an
 * optional onUnlinked callback, fired exactly when a known FP customer id
 * resolved to no native row (strict lookup miss, and the healer either absent
 * or also missing). Never fired when resolution succeeds, or when the invoice
 * carries no FP customer id at all. The webhook and daily cron simply omit the
 * callback, so this is pure addition — their behaviour is unchanged.
 */
describe("upsertInvoiceRecord — onUnlinked callback (residual instrumentation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  /** select #1 = customer lookup, #2 = existing invoice. */
  function wireSelects(customerRows: unknown[], invoiceRows: unknown[]) {
    const results = [customerRows, invoiceRows];
    let call = 0;
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: () => ({
            where: () => {
              const r = results[call] ?? [];
              call++;
              return Object.assign(Promise.resolve(r), {
                limit: () => Promise.resolve(r),
              });
            },
          }),
        }) as never,
    );
  }

  it("fires onUnlinked with the fp customer id when the strict lookup misses and there is no healer", async () => {
    wireSelects([], []); // customer miss, invoice new → INSERT branch
    wireInsert();
    const onUnlinked = vi.fn();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ customerId: "17492296" }),
      undefined,
      onUnlinked,
    );

    expect(onUnlinked).toHaveBeenCalledTimes(1);
    expect(onUnlinked).toHaveBeenCalledWith("17492296");
  });

  it("fires onUnlinked when the healer is consulted and also misses", async () => {
    wireSelects([], []);
    wireInsert();
    const heal = vi.fn().mockResolvedValue(null);
    const onUnlinked = vi.fn();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ customerId: "99999999" }),
      heal,
      onUnlinked,
    );

    expect(onUnlinked).toHaveBeenCalledTimes(1);
    expect(onUnlinked).toHaveBeenCalledWith("99999999");
  });

  it("does NOT fire onUnlinked when the strict lookup resolves", async () => {
    wireSelects([{ id: "cust-1" }], []);
    wireInsert();
    const onUnlinked = vi.fn();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ customerId: "17431130" }),
      undefined,
      onUnlinked,
    );

    expect(onUnlinked).not.toHaveBeenCalled();
  });

  it("does NOT fire onUnlinked when the healer resolves", async () => {
    wireSelects([], []);
    wireInsert();
    const heal = vi.fn().mockResolvedValue("healed-customer-id");
    const onUnlinked = vi.fn();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ customerId: "17492296" }),
      heal,
      onUnlinked,
    );

    expect(onUnlinked).not.toHaveBeenCalled();
  });

  it("does NOT fire onUnlinked when the invoice carries no fp customer id", async () => {
    wireSelectNoExisting();
    wireInsert();
    const onUnlinked = vi.fn();

    await upsertInvoiceRecord(ORG, makeInvoice(), undefined, onUnlinked);

    expect(onUnlinked).not.toHaveBeenCalled();
  });
});

/**
 * The importer skips soft-deleted invoices, but upsertInvoiceRecord is also the
 * webhook and daily-cron entry point and had no such check. A deleted
 * FieldPulse invoice arriving that way was mirrored as an open balance, given a
 * customer, and handed to collections — and nothing downstream could correct
 * it, because deriveInvoiceState never returns "void".
 */
describe("upsertInvoiceRecord — a deleted FieldPulse invoice never becomes live AR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  it("refuses to create a mirror row for a deleted invoice", async () => {
    const where = vi.fn().mockResolvedValue([]); // no existing row
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where }) } as never);
    const insert = vi.mocked(db.insert);

    const outcome = await upsertInvoiceRecord(
      ORG,
      makeInvoice({ deletedAt: "2026-08-01 00:00:00" }),
    );

    expect(outcome).toBe("skipped");
    expect(insert).not.toHaveBeenCalled();
  });

  it("surfaces a row that is still live locally but deleted upstream", async () => {
    const where = vi.fn().mockResolvedValue([{ id: "inv-1", state: "open" }]);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where }) } as never);

    const outcome = await upsertInvoiceRecord(
      ORG,
      makeInvoice({ deletedAt: "2026-08-01 00:00:00" }),
    );

    // Voiding is a money mutation, so it is reported for a human, not performed.
    expect(outcome).toBe("skipped");
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

/**
 * FieldPulse emits invoices with total > 0, amount_paid 0.00, amount_unpaid
 * 0.00, no payments and no payment date. A zero balance on a positive total
 * implies someone paid, so trusting amount_unpaid recorded them as fully paid —
 * AR understated, collections never chasing them, the export calling them
 * collected. 102 such rows in the dev mirror; upstream, FieldPulse's own status
 * reads open on the ones sampled.
 */
describe("deriveInvoiceState — a zero balance is not proof of payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  function captureInsert() {
    wireSelectNoExisting();
    return wireInsert();
  }

  it("keeps an invoice open when nothing evidences a payment", async () => {
    const { getInvoiceValues } = captureInsert();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({
        totalCents: 36847,
        amountPaidCents: 0,
        amountUnpaidCents: 0, // contradicts the total — not trustworthy alone
        paidAt: null,
      }),
    );

    const row = getInvoiceValues()?.mock.calls[0]?.[0];
    expect(row?.state).toBe("open");
    // And must not fabricate the payment either.
    expect(row?.amountPaidCents).toBe(0);
  });

  it("still marks paid when a payment date evidences it, filling the zeroed amount", async () => {
    const { getInvoiceValues } = captureInsert();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({
        totalCents: 36847,
        amountPaidCents: 0,
        amountUnpaidCents: 0,
        paidAt: "2026-07-02 10:00:00",
      }),
    );

    const row = getInvoiceValues()?.mock.calls[0]?.[0];
    expect(row?.state).toBe("paid");
    // The original H2 case: FP zeroed the amount but the invoice is settled.
    expect(row?.amountPaidCents).toBe(36847);
  });

  it("still marks paid on a normal fully-paid invoice", async () => {
    const { getInvoiceValues } = captureInsert();

    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ totalCents: 27000, amountPaidCents: 27000, amountUnpaidCents: 0 }),
    );

    expect(getInvoiceValues()?.mock.calls[0]?.[0]?.state).toBe("paid");
  });
});

// ── pullOpenFieldpulseInvoices ────────────────────────────────────────────────

describe("pullOpenFieldpulseInvoices", () => {
  beforeEach(() => vi.clearAllMocks());

  /** The open-invoice id query: select().from().where().orderBy().limit(). */
  function mockOpenIds(ids: (string | null)[]) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(ids.map((fieldpulseInvoiceId) => ({ fieldpulseInvoiceId }))),
          }),
        }),
      }),
    } as never);
  }

  it("does nothing when the org is not connected", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue(null as never);
    const result = await pullOpenFieldpulseInvoices(ORG);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("fetches each open invoice by its own id and isolates failures", async () => {
    const getInvoice = vi.fn(async (id: string) => {
      if (id === "boom") throw new Error("HTTP 500");
      return null; // gone in FieldPulse → skipped
    });
    vi.mocked(getFieldpulseClient).mockResolvedValue({ getInvoice } as never);
    mockOpenIds(["60000001", "boom", "60000003", "60000004", "60000005", "60000006"]);

    const result = await pullOpenFieldpulseInvoices(ORG);

    expect(getInvoice).toHaveBeenCalledTimes(6);
    expect(getInvoice).toHaveBeenCalledWith("60000006");
    expect(result).toEqual({ created: 0, updated: 0, skipped: 5, failed: 1 });
  });
});

// ── Workflow status_id decides the state (invoice-status.ts) ───────────────────

describe("upsertInvoiceRecord — state comes from FieldPulse's status workflow", () => {
  const LOOKUP = new Map([
    ["1878561", { name: "Invoice Draft", type: "invoice_draft" }],
    ["1878563", { name: "Sent", type: "invoice_sent" }],
    ["1878564", { name: "Partially Paid", type: "invoice_partially_paid" }],
    ["1878565", { name: "Paid", type: "invoice_paid" }],
    ["1878566", { name: "Void", type: "invoice_void" }],
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);
  });

  function insertState() {
    wireSelectNoExisting();
    return wireInsert();
  }

  function wireExisting(state: string) {
    const where = vi.fn().mockResolvedValue([{ id: "existing-invoice", state }]);
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as never);
    let captured: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockReturnValue({
      set: (v: Record<string, unknown>) => {
        captured = v;
        return { where: vi.fn() };
      },
    } as never);
    return () => captured;
  }

  it("an unsent draft with a balance lands draft, not open", async () => {
    const { getInvoiceValues } = insertState();
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878561", totalCents: 152238, amountPaidCents: 0, amountUnpaidCents: 152238 }),
      undefined,
      undefined,
      LOOKUP,
    );
    expect(getInvoiceValues()?.mock.calls[0]?.[0]?.state).toBe("draft");
  });

  it("a void invoice lands void even though the amounts look unpaid", async () => {
    const { getInvoiceValues } = insertState();
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878566", totalCents: 63158, amountPaidCents: 0, amountUnpaidCents: 0 }),
      undefined,
      undefined,
      LOOKUP,
    );
    const row = getInvoiceValues()?.mock.calls[0]?.[0];
    expect(row?.state).toBe("void");
    expect(row?.amountPaidCents).toBe(0);
  });

  it("partially paid is open and keeps FieldPulse's amount_paid, so the balance is amount_unpaid", async () => {
    const { getInvoiceValues } = insertState();
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878564", totalCents: 100000, amountPaidCents: 40000, amountUnpaidCents: 60000 }),
      undefined,
      undefined,
      LOOKUP,
    );
    const row = getInvoiceValues()?.mock.calls[0]?.[0];
    expect(row?.state).toBe("open");
    expect(row?.totalCents - row?.amountPaidCents).toBe(60000);
  });

  it("re-sync moves a stored open row to void", async () => {
    const getSet = wireExisting("open");
    await upsertInvoiceRecord(ORG, makeInvoice({ statusId: "1878566", amountPaidCents: 0 }), undefined, undefined, LOOKUP);
    expect(getSet()?.state).toBe("void");
  });

  it("re-sync moves a stored paid row back to draft when FieldPulse says draft", async () => {
    const getSet = wireExisting("paid");
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878561", totalCents: 5000, amountPaidCents: 0, amountUnpaidCents: 5000 }),
      undefined,
      undefined,
      LOOKUP,
    );
    expect(getSet()?.state).toBe("draft");
    expect(getSet()?.amountPaidCents).toBe(0);
  });

  it.each([
    ["no lookup", undefined],
    ["a failed lookup", null],
    ["an EMPTY lookup", new Map()],
  ])("with %s, a stored row keeps its state", async (_label, lookup) => {
    const getSet = wireExisting("void");
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878563", totalCents: 5000, amountPaidCents: 0, amountUnpaidCents: 5000 }),
      undefined,
      undefined,
      lookup as Map<string, { name: string; type: string }> | null | undefined,
    );
    expect(getSet()?.state).toBe("void");
  });

  it("an unknown status_id keeps the stored state", async () => {
    const getSet = wireExisting("draft");
    await upsertInvoiceRecord(ORG, makeInvoice({ statusId: "999", amountPaidCents: 0 }), undefined, undefined, LOOKUP);
    expect(getSet()?.state).toBe("draft");
  });

  it("a NEW row without a usable lookup falls back to the amounts", async () => {
    const { getInvoiceValues } = insertState();
    await upsertInvoiceRecord(
      ORG,
      makeInvoice({ statusId: "1878566", totalCents: 5000, amountPaidCents: 0, amountUnpaidCents: 5000 }),
      undefined,
      undefined,
      new Map(),
    );
    expect(getInvoiceValues()?.mock.calls[0]?.[0]?.state).toBe("open");
  });
});
