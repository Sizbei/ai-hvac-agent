import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addJobMaterial,
  removeJobMaterial,
  getActualMaterialsCostCents,
  getJobTimelineForTech,
  addJobPhoto,
  listJobPhotos,
  recordSignature,
  isJobOwnedByTech,
} from "./field-queries";
import { db } from "@/lib/db";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { adjustStock } from "@/lib/admin/inventory-queries";

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

vi.mock("@/lib/admin/inventory-queries", () => ({
  adjustStock: vi.fn().mockResolvedValue(undefined),
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

/** Mock db.update(...).set(...).where(...).returning() → rows. */
function mockUpdateReturning(rows: unknown[]): void {
  vi.mocked(db.update).mockReturnValue({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
  } as never);
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
      isLaborItem: false,
      fieldpulseItemId: null,
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
    // A catalog line draws down tracked inventory by the used quantity (a
    // no-op for untracked items). Best-effort, but always attempted.
    expect(adjustStock).toHaveBeenCalledWith(ORG, "pb-1", -2);
  });

  it("still records the material when the stock decrement fails (best-effort)", async () => {
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
      isLaborItem: false,
      fieldpulseItemId: null,
    });
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: "mat-1" }]) }),
    } as never);
    vi.mocked(adjustStock).mockRejectedValueOnce(new Error("db down"));

    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-1",
      quantity: 1,
    });
    expect(r).toEqual({ ok: true, id: "mat-1" });
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
    // Manual (off-catalog) lines never touch inventory.
    expect(adjustStock).not.toHaveBeenCalled();
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

describe("getJobTimelineForTech", () => {
  it("returns the ordered, PII-free status timeline for an owned job", async () => {
    const at1 = new Date("2026-06-24T10:00:00.000Z");
    const at2 = new Date("2026-06-24T12:30:00.000Z");
    mockSelectSeq([
      [{ id: JOB }], // ownership guard → owned
      [
        { fromStatus: null, toStatus: "pending", actorType: "ai", at: at1 },
        { fromStatus: "pending", toStatus: "assigned", actorType: "system", at: at2 },
      ],
    ]);

    const res = await getJobTimelineForTech(ORG, TECH, JOB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timeline).toEqual([
      { fromStatus: null, toStatus: "pending", actorType: "ai", at: at1.toISOString() },
      { fromStatus: "pending", toStatus: "assigned", actorType: "system", at: at2.toISOString() },
    ]);
  });

  it("refuses a job not assigned to the tech (not_owned)", async () => {
    mockSelectSeq([[]]); // ownership guard misses
    const res = await getJobTimelineForTech(ORG, "other-tech", JOB);
    expect(res).toEqual({ ok: false, reason: "not_owned" });
  });

  it("returns an empty timeline for an owned job with no events", async () => {
    mockSelectSeq([[{ id: JOB }], []]);
    const res = await getJobTimelineForTech(ORG, TECH, JOB);
    expect(res).toEqual({ ok: true, timeline: [] });
  });
});

describe("addJobPhoto", () => {
  const photo = {
    filename: "before.jpg",
    mimeType: "image/jpeg",
    size: 12345,
    storageKey: "org-1/job-1/before.jpg",
  };

  it("records the attachment for an owned job (linked to the service request)", async () => {
    mockSelectSeq([[{ id: JOB }]]); // ownership guard → owned
    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "att-1" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await addJobPhoto(ORG, TECH, JOB, photo);
    expect(r).toEqual({ ok: true, id: "att-1" });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        serviceRequestId: JOB,
        filename: "before.jpg",
        mimeType: "image/jpeg",
        size: 12345,
        storageKey: "org-1/job-1/before.jpg",
      }),
    );
  });

  it("refuses a job not assigned to the tech (not_owned, no insert)", async () => {
    mockSelectSeq([[]]); // ownership guard misses
    const r = await addJobPhoto(ORG, "other-tech", JOB, photo);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("recordSignature", () => {
  const SIG = { signatureUrl: "https://r2/sig.png", signatureName: "Jane Doe" };

  it("persists the signature for the owning tech", async () => {
    mockSelectSeq([[{ id: JOB }]]); // findOwnedJob → owned
    mockUpdateReturning([{ id: JOB }]); // guarded UPDATE hits the row
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: true });
  });

  it("refuses a job not assigned to the tech (not_owned, no write)", async () => {
    mockSelectSeq([[]]); // findOwnedJob → none
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it("refuses if the job is reassigned between the ownership check and the write (TOCTOU)", async () => {
    mockSelectSeq([[{ id: JOB }]]); // owned at read time…
    mockUpdateReturning([]); // …but the assignee-guarded UPDATE matches 0 rows
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
  });
});

describe("listJobPhotos", () => {
  it("returns the job's attachments oldest-first (org-scoped)", async () => {
    const rows = [
      { id: "a1", filename: "1.jpg", mimeType: "image/jpeg", size: 10, storageKey: "k1", createdAt: new Date("2026-06-24T10:00:00Z") },
      { id: "a2", filename: "2.png", mimeType: "image/png", size: 20, storageKey: "k2", createdAt: new Date("2026-06-24T11:00:00Z") },
    ];
    mockSelectSeq([rows]);
    const out = await listJobPhotos(ORG, JOB);
    expect(out).toEqual(rows);
  });
});

describe("isJobOwnedByTech", () => {
  it("true when the ownership read returns the job", async () => {
    mockSelectSeq([[{ id: JOB }]]);
    expect(await isJobOwnedByTech(ORG, TECH, JOB)).toBe(true);
  });
  it("false when the job is not assigned to this tech / not in org", async () => {
    mockSelectSeq([[]]);
    expect(await isJobOwnedByTech(ORG, TECH, JOB)).toBe(false);
  });
});

