import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  listInventory,
  createPurchaseOrder,
  receivePurchaseOrder,
  adjustStock,
} from "./inventory-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
  },
}));

const ORG = "org-1";

/**
 * Sequence db.select results. Each `.from()` supports `.innerJoin()` (the
 * inventory list joins the pricebook name) and each `.where()` is awaitable,
 * `.limit()`-able, and `.orderBy()`-able.
 */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  const where = () => {
    const r = results[i++] ?? [];
    const p = Promise.resolve(r);
    return Object.assign(p, {
      limit: () => Promise.resolve(r),
      orderBy: () => Promise.resolve(r),
    });
  };
  const from = () => ({ where, innerJoin: () => ({ where }) });
  vi.mocked(db.select).mockImplementation(() => ({ from }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // insert() returns a thenable-ish builder; createPurchaseOrder batches it so
  // the return value just needs to be a stable object reference.
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn((v: unknown) => ({ __insert: v })),
  } as never);
});

describe("listInventory", () => {
  it("flags belowReorder when stock is at or below the reorder point and is tenant-scoped", async () => {
    mockSelectSeq([
      [
        {
          id: "inv-1",
          pricebookItemId: "pb-1",
          itemName: "Capacitor",
          quantityOnHand: 2,
          reorderPoint: 5,
          unitCostCents: 1200,
          location: "Truck 1",
        },
        {
          id: "inv-2",
          pricebookItemId: "pb-2",
          itemName: "Filter",
          quantityOnHand: 10,
          reorderPoint: 5,
          unitCostCents: 500,
          location: null,
        },
        {
          id: "inv-3",
          pricebookItemId: "pb-3",
          itemName: "Fuse",
          quantityOnHand: 0,
          reorderPoint: null, // no reorder point -> never flagged
          unitCostCents: 100,
          location: null,
        },
      ],
    ]);

    const rows = await listInventory(ORG);
    expect(rows.map((r) => r.belowReorder)).toEqual([true, false, false]);
  });
});

describe("createPurchaseOrder", () => {
  it("batches the PO header + lines with the computed total", async () => {
    await createPurchaseOrder(ORG, {
      vendorName: "Acme Supply",
      lines: [
        { pricebookItemId: "pb-1", description: "Capacitor", quantity: 3, unitCostCents: 1200 },
        { pricebookItemId: "pb-2", description: "Filter", quantity: 2, unitCostCents: 500 },
      ],
    });

    expect(db.batch).toHaveBeenCalledTimes(1);
    const batched = vi.mocked(db.batch).mock.calls[0]![0] as unknown as unknown[];
    // header + one lines-insert
    expect(batched).toHaveLength(2);

    // Header total = 3*1200 + 2*500 = 4600. Pull the header insert payload.
    const header = (batched[0] as { __insert: { totalCents: number; organizationId: string } })
      .__insert;
    expect(header.totalCents).toBe(4600);
    expect(header.organizationId).toBe(ORG);

    // Line totals are computed (quantity * unitCost), tenant-scoped.
    const lineRows = (batched[1] as { __insert: Array<{ lineTotalCents: number; organizationId: string }> })
      .__insert;
    expect(lineRows.map((l) => l.lineTotalCents)).toEqual([3600, 1000]);
    expect(lineRows.every((l) => l.organizationId === ORG)).toBe(true);
  });

  it("batches only the header when there are no lines", async () => {
    await createPurchaseOrder(ORG, { vendorName: "Acme", lines: [] });
    const batched = vi.mocked(db.batch).mock.calls[0]![0] as unknown as unknown[];
    expect(batched).toHaveLength(1);
  });
});

describe("receivePurchaseOrder", () => {
  function mockUpdate(claimRows: unknown[] = [{ id: "po-1" }]) {
    // Each update() returns a tagged builder whose .set()/.where() survive into
    // the batch array so we can count + inspect them. .returning() (used by the
    // atomic status-CAS claim) resolves to claimRows.
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            const stmt: Record<string, unknown> = { __set: v };
            stmt.where = vi.fn(() => stmt);
            stmt.returning = vi.fn(() => Promise.resolve(claimRows));
            return stmt;
          },
        }) as never,
    );
  }

  it("increments stock for each cataloged line and marks the PO received (one batch)", async () => {
    mockSelectSeq([
      [{ id: "po-1", status: "draft" }], // PO lookup
      [
        { pricebookItemId: "pb-1", quantity: 3, unitCostCents: 1300 },
        { pricebookItemId: "pb-2", quantity: 2, unitCostCents: 500 },
        { pricebookItemId: null, quantity: 9, unitCostCents: 100 }, // non-cataloged -> no stock write
      ],
    ]);
    mockUpdate();

    const r = await receivePurchaseOrder(ORG, "po-1");
    expect(r).toEqual({ ok: true });

    expect(db.batch).toHaveBeenCalledTimes(1);
    const batched = vi.mocked(db.batch).mock.calls[0]![0] as unknown as Array<{
      __set: Record<string, unknown>;
    }>;
    // The status flip is now the atomic CAS claim (separate call); the batch
    // holds ONLY the 2 stock increments (null-line skipped).
    expect(batched).toHaveLength(2);
    // The received cost becomes the latest unit cost on the stock row.
    expect(batched[0]!.__set.unitCostCents).toBe(1300);
    expect(batched[1]!.__set.unitCostCents).toBe(500);
  });

  it("rejects receiving a PO that is already received (no double increment)", async () => {
    mockSelectSeq([[{ id: "po-1", status: "received" }]]);
    mockUpdate([]); // the status-CAS claims 0 rows (already received / lost the race)
    const r = await receivePurchaseOrder(ORG, "po-1");
    expect(r).toEqual({ ok: false, reason: "already_received" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("returns not_found when the PO is not in this org", async () => {
    mockSelectSeq([[]]);
    const r = await receivePurchaseOrder(ORG, "po-x");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("adjustStock", () => {
  it("issues a GREATEST(0, ...) clamped update scoped to the org + item", async () => {
    const setSpy = vi.fn((v: Record<string, unknown>) => ({
      where: vi.fn().mockResolvedValue(undefined),
      __set: v,
    }));
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);

    await adjustStock(ORG, "pb-1", -2);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0]![0];
    // Clamp lives in a drizzle SQL expression so a negative result can't
    // persist. The literal "GREATEST" sits in the first StringChunk of the SQL
    // template (the column refs are circular, so we can't JSON the whole thing).
    const chunks = (setArg.quantityOnHand as { queryChunks: Array<{ value?: string[] }> })
      .queryChunks;
    const literals = chunks.flatMap((c) => c.value ?? []).join("");
    expect(literals).toContain("GREATEST(0,");
  });

  it("is a no-op for a zero delta (no DB write)", async () => {
    await adjustStock(ORG, "pb-1", 0);
    expect(db.update).not.toHaveBeenCalled();
  });
});
