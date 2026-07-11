/**
 * Safety: FieldPulse-synced estimates MUST be refused by every admin mutation.
 * Synced estimates have `fieldpulseEstimateId != null`; their status/invoicing
 * are owned by FieldPulse, so native mutations would cause data corruption.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { markEstimateSold, listEstimates, getEstimateDetailById } from "./estimate-queries";
import { createInvoiceFromSoldEstimate } from "./invoice-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    batch: vi.fn(),
  },
}));

const mockedSelect = db.select as unknown as ReturnType<typeof vi.fn>;
const ORG = "org-1";

/** A `.from().where().orderBy().limit().offset()`-shaped result. */
function limitChain(rows: unknown[]) {
  const p = Promise.resolve(rows);
  // Deep chain: every method returns something that can continue chaining OR be awaited.
  const deepChain: Record<string, unknown> = {};
  const deepPromise = Object.assign(Promise.resolve(rows), {
    get offset() { return () => deepPromise; },
    get limit() { return () => deepPromise; },
    get orderBy() { return () => deepPromise; },
    get where() { return () => deepPromise; },
    get from() { return () => deepPromise; },
  });
  deepChain.from = () => deepPromise;
  deepChain.where = () => deepPromise;
  deepChain.leftJoin = () => deepPromise;
  deepChain.orderBy = () => deepPromise;
  deepChain.limit = () => deepPromise;
  deepChain.offset = () => deepPromise;
  deepChain.then = p.then.bind(p);
  // Make the chain itself awaitable (resolves to rows)
  return Object.assign(Promise.resolve(rows), deepChain);
}

/** Sequence multiple selects: each call to db.select() returns the next rows. */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  mockedSelect.mockImplementation(() => limitChain(results[i++] ?? []));
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// markEstimateSold
// ---------------------------------------------------------------------------
describe("markEstimateSold — synced guard", () => {
  it("refuses a FieldPulse-synced estimate and never calls db.update", async () => {
    mockSelectSeq([[{ id: "est-fp", status: "open", fieldpulseEstimateId: "fp-42" }]]);
    const r = await markEstimateSold(ORG, "est-fp", "opt-1");
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("still marks a native (non-synced) estimate sold", async () => {
    mockSelectSeq([
      [{ id: "est-1", status: "open", fieldpulseEstimateId: null }],
      [{ id: "opt-1" }],
    ]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "est-1" }]),
        })),
      })),
    } as never);
    const r = await markEstimateSold(ORG, "est-1", "opt-1");
    expect(r).toEqual({ ok: true, estimateId: "est-1" });
  });
});

// ---------------------------------------------------------------------------
// createInvoiceFromSoldEstimate
// ---------------------------------------------------------------------------
describe("createInvoiceFromSoldEstimate — synced guard", () => {
  it("refuses a FieldPulse-synced estimate and never inserts", async () => {
    mockSelectSeq([
      [{
        id: "est-fp",
        status: "sold",
        soldOptionId: "opt-1",
        customerId: "cust-1",
        serviceRequestId: null,
        fieldpulseEstimateId: "fp-99",
      }],
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-fp");
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("proceeds for a native (non-synced) sold estimate", async () => {
    // 1: estimate row, 2: no existing invoice, 3: option totals, 4: line items
    mockSelectSeq([
      [{ id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c-1", serviceRequestId: null, fieldpulseEstimateId: null }],
      [], // no existing invoice
      [{ subtotalCents: 10000, taxCents: 0, totalCents: 10000 }],
      [],  // no line items
    ]);
    vi.mocked(db.batch).mockResolvedValue([] as never);
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn(() => ({})) } as never);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listEstimates — syncedSource derived correctly
// ---------------------------------------------------------------------------
describe("listEstimates — syncedSource", () => {
  it("exposes syncedSource=fieldpulse for rows with fieldpulseEstimateId set", async () => {
    const pageRows = [
      { id: "est-fp", status: "sold", totalCents: 500, customerId: null, serviceRequestId: null, createdAt: new Date(), expiresAt: null, signedAt: null, fieldpulseEstimateId: "fp-1", fieldpulseStatusName: null, title: null, fieldpulseData: null },
      { id: "est-nat", status: "open", totalCents: 200, customerId: null, serviceRequestId: null, createdAt: new Date(), expiresAt: null, signedAt: null, fieldpulseEstimateId: null, fieldpulseStatusName: null, title: null, fieldpulseData: null },
    ];
    // listEstimates now fires two selects: count then page rows
    mockSelectSeq([
      [{ n: 2 }], // count
      pageRows,   // rows
    ]);
    const { estimates } = await listEstimates(ORG);
    const fp = estimates.find((r) => r.id === "est-fp")!;
    const native = estimates.find((r) => r.id === "est-nat")!;
    expect(fp.syncedSource).toBe("fieldpulse");
    expect(native.syncedSource).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getEstimateDetailById — syncedSource derived correctly
// ---------------------------------------------------------------------------
describe("getEstimateDetailById — syncedSource", () => {
  it("returns syncedSource=fieldpulse for a synced estimate", async () => {
    // First select: the estimate header. Second: options. Third: line items.
    mockSelectSeq([
      [{ id: "est-fp", status: "sold", totalCents: 0, customerId: null, serviceRequestId: null, soldOptionId: null, signedAt: null, signatureName: null, expiresAt: null, createdAt: new Date(), fieldpulseEstimateId: "fp-7" }],
      [], // estimateOptions
      [], // line items
    ]);
    const detail = await getEstimateDetailById(ORG, "est-fp");
    expect(detail?.syncedSource).toBe("fieldpulse");
  });

  it("returns syncedSource=null for a native estimate", async () => {
    mockSelectSeq([
      [{ id: "est-1", status: "open", totalCents: 0, customerId: null, serviceRequestId: null, soldOptionId: null, signedAt: null, signatureName: null, expiresAt: null, createdAt: new Date(), fieldpulseEstimateId: null }],
      [],
      [],
    ]);
    const detail = await getEstimateDetailById(ORG, "est-1");
    expect(detail?.syncedSource).toBeNull();
  });
});
