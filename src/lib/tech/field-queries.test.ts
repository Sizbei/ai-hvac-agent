import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addJobMaterial,
  removeJobMaterial,
  getActualMaterialsCostCents,
} from "./field-queries";
import { db } from "@/lib/db";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/admin/pricebook-queries", () => ({
  getPricebookItemById: vi.fn(),
}));

const ORG = "org-1";
const TECH = "tech-1";
const JOB = "job-1";

/**
 * Sequence db.select results. Each call returns a chain whose where() is BOTH
 * awaitable (for list reads) and .limit()-able (for the ownership guard).
 */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = results[i++] ?? [];
    const result = Promise.resolve(rows);
    return {
      from: () => ({
        where: () =>
          Object.assign(result, {
            limit: () => Promise.resolve(rows),
            orderBy: () => Promise.resolve(rows),
          }),
      }),
    } as never;
  });
}

beforeEach(() => vi.clearAllMocks());

describe("addJobMaterial — catalog line", () => {
  it("snapshots cost/price from the pricebook item and ignores client costs", async () => {
    // 1) ownership guard -> owned job
    mockSelectSeq([[{ id: JOB }]]);
    vi.mocked(getPricebookItemById).mockResolvedValue({
      id: "pb-1",
      organizationId: ORG,
      type: "material",
      name: "Capacitor",
      sku: null,
      description: null,
      categoryId: null,
      costCents: 1200,
      markupPct: 0,
      priceCents: 3500,
      memberPriceCents: null,
      hours: null,
      warranty: null,
      active: true,
    });

    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "mat-1" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-1",
      quantity: 2,
    });

    expect(r).toEqual({ ok: true, id: "mat-1" });
    // Snapshotted from the item, NOT from any client-sent value.
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pricebookItemId: "pb-1",
        unitCostCents: 1200,
        unitPriceCents: 3500,
        quantity: 2,
        createdBy: TECH,
        organizationId: ORG,
        serviceRequestId: JOB,
      }),
    );
  });

  it("returns item_not_found when the pricebook item is missing", async () => {
    mockSelectSeq([[{ id: JOB }]]);
    vi.mocked(getPricebookItemById).mockResolvedValue(null);
    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-x",
      quantity: 1,
    });
    expect(r).toEqual({ ok: false, reason: "item_not_found" });
  });
});

describe("addJobMaterial — manual line", () => {
  it("defaults costs to 0 and never reads the pricebook", async () => {
    mockSelectSeq([[{ id: JOB }]]);
    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "mat-2" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "Misc fittings",
      quantity: 3,
    });

    expect(r).toEqual({ ok: true, id: "mat-2" });
    expect(getPricebookItemById).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pricebookItemId: null,
        description: "Misc fittings",
        unitCostCents: 0,
        unitPriceCents: 0,
        quantity: 3,
      }),
    );
  });

  it("rejects a manual line with no description", async () => {
    mockSelectSeq([[{ id: JOB }]]);
    const r = await addJobMaterial(ORG, TECH, JOB, { quantity: 1 });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rejects a non-positive quantity before any DB read", async () => {
    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "x",
      quantity: 0,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("assignee guard", () => {
  it("a tech cannot add a material to a job not assigned to them", async () => {
    // ownership guard returns no rows -> not owned
    mockSelectSeq([[]]);
    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "x",
      quantity: 1,
    });
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("a tech cannot remove a material on a job not assigned to them", async () => {
    // 1) material lookup -> found on JOB; 2) ownership guard -> not owned
    mockSelectSeq([[{ serviceRequestId: JOB }], []]);
    const r = await removeJobMaterial(ORG, TECH, "mat-9");
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("removes a material the tech owns", async () => {
    mockSelectSeq([[{ serviceRequestId: JOB }], [{ id: JOB }]]);
    vi.mocked(db.delete).mockReturnValue({
      where: () => Promise.resolve(undefined),
    } as never);
    const r = await removeJobMaterial(ORG, TECH, "mat-9");
    expect(r).toEqual({ ok: true });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe("getActualMaterialsCostCents", () => {
  it("sums unitCost × quantity across recorded materials", async () => {
    mockSelectSeq([
      [
        { quantity: 2, unitCostCents: 1200 }, // 2400
        { quantity: 1, unitCostCents: 500 }, // 500
        { quantity: 3, unitCostCents: 0 }, // 0 (manual line)
      ],
    ]);
    const total = await getActualMaterialsCostCents(ORG, JOB);
    expect(total).toBe(2900);
  });

  it("is 0 when no materials were recorded", async () => {
    mockSelectSeq([[]]);
    const total = await getActualMaterialsCostCents(ORG, JOB);
    expect(total).toBe(0);
  });
});
