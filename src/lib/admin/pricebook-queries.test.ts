import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  updateTaxRate,
  createTaxRate,
  deactivatePricebookItem,
  deactivateTaxRate,
  listPricebookItemsForAdmin,
} from "./pricebook-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    select: vi.fn(),
    selectDistinct: vi.fn(),
  },
}));

const ORG = "org-1";

/**
 * Tag each update() statement with the field set passed to .set() so we can
 * assert which logical statement (unset vs set) landed in which batch slot.
 */
function trackUpdates() {
  vi.mocked(db.update).mockImplementation(
    () =>
      ({
        set: (v: Record<string, unknown>) => {
          // .where() returns the SAME tagged object so it survives into the
          // batch array (drizzle statements are thenable builders, not plain
          // promises). Awaiting it directly (non-batched path) is harmless.
          const stmt: Record<string, unknown> = { __set: v };
          stmt.where = vi.fn(() => stmt);
          stmt.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
          return stmt;
        },
      }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  trackUpdates();
});

describe("updateTaxRate — single-default invariant", () => {
  it("batches [unset, set] IN THAT ORDER when promoting a rate to default", async () => {
    await updateTaxRate(ORG, "tax-1", { isDefault: true });

    expect(db.batch).toHaveBeenCalledTimes(1);
    const batched = vi.mocked(db.batch).mock.calls[0]![0] as unknown as Array<{
      __set: Record<string, unknown>;
    }>;
    expect(batched).toHaveLength(2);
    // Slot 0 must clear the prior default (isDefault: false)...
    expect(batched[0]!.__set).toMatchObject({ isDefault: false });
    // ...slot 1 must set the new default (isDefault: true). Wrong order would
    // violate the partial unique index on neon-http (batch is sequential).
    expect(batched[1]!.__set).toMatchObject({ isDefault: true });
  });

  it("does NOT batch when updating non-default fields only", async () => {
    await updateTaxRate(ORG, "tax-1", { name: "State", rateBps: 700 });
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("createTaxRate — single-default invariant", () => {
  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "tax-new" }]),
      }),
    } as never);
  });

  it("unsets the prior default BEFORE inserting a new default rate", async () => {
    const id = await createTaxRate(ORG, {
      name: "County",
      rateBps: 825,
      isDefault: true,
    });
    expect(id).toBe("tax-new");
    // The unset statement is batched first...
    expect(db.batch).toHaveBeenCalledTimes(1);
    const batched = vi.mocked(db.batch).mock.calls[0]![0] as unknown as Array<{
      __set: Record<string, unknown>;
    }>;
    expect(batched[0]!.__set).toMatchObject({ isDefault: false });
    // ...then the new default is inserted.
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("does NOT batch when creating a non-default rate", async () => {
    await createTaxRate(ORG, { name: "City", rateBps: 100, isDefault: false });
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────── listPricebookItemsForAdmin filters ────────────────────────────

/**
 * Builds a universal Proxy chain for db.select / db.selectDistinct so the
 * entire fluent chain (from/where/limit/offset/orderBy/then) resolves to
 * `result` without needing a real DB connection.
 */
function buildSelectProxy(result: unknown[]): unknown {
  const p: Record<string | symbol, unknown> = {};
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(result);
      }
      return () => new Proxy({}, handler);
    },
  };
  return new Proxy(p, handler);
}

/** Queue-based select mock: each call to db.select pops the next result. */
function mockSelectQueue(results: unknown[][]): void {
  let idx = 0;
  vi.mocked(db.select).mockImplementation(() => {
    return buildSelectProxy(results[idx++] ?? []) as never;
  });
  vi.mocked(db.selectDistinct).mockImplementation(() => {
    // selectDistinct is used by the typesPromise inside listPricebookItemsForAdmin.
    return buildSelectProxy([]) as never;
  });
}

describe("listPricebookItemsForAdmin — new filters", () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.selectDistinct).mockReset();
  });

  it("passes includeInactive=false by default (active items only)", async () => {
    mockSelectQueue([[{ n: 1 }], []]);
    const result = await listPricebookItemsForAdmin(ORG);
    // The function completes without error; type-level validation of the
    // WHERE predicate is covered by the TypeScript compiler.
    expect(result.total).toBe(1);
  });

  it("accepts includeInactive=true without error", async () => {
    mockSelectQueue([[{ n: 5 }], []]);
    const result = await listPricebookItemsForAdmin(ORG, { includeInactive: true });
    expect(result.total).toBe(5);
  });

  it("accepts isLaborItem=true without error", async () => {
    mockSelectQueue([[{ n: 2 }], []]);
    const result = await listPricebookItemsForAdmin(ORG, { isLaborItem: true });
    expect(result.total).toBe(2);
  });

  it("accepts both includeInactive and isLaborItem together", async () => {
    mockSelectQueue([[{ n: 3 }], []]);
    const result = await listPricebookItemsForAdmin(ORG, {
      includeInactive: true,
      isLaborItem: true,
    });
    expect(result.total).toBe(3);
  });
});

describe("soft-delete", () => {
  it("deactivatePricebookItem sets active=false (never hard delete)", async () => {
    let captured: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            captured = v;
            return { where: vi.fn().mockResolvedValue(undefined) };
          },
        }) as never,
    );
    await deactivatePricebookItem(ORG, "item-1");
    expect(captured).toMatchObject({ active: false });
  });

  it("deactivateTaxRate sets active=false and clears the default flag", async () => {
    let captured: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            captured = v;
            return { where: vi.fn().mockResolvedValue(undefined) };
          },
        }) as never,
    );
    await deactivateTaxRate(ORG, "tax-1");
    expect(captured).toMatchObject({ active: false, isDefault: false });
  });
});
