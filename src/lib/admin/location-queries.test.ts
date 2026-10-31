/**
 * Tests for Stage 5 customer-location queries.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  upsertCustomerLocation,
  getEquipmentServiceHistory,
  setPrimaryLocation,
} from "./location-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), batch: vi.fn(), execute: vi.fn() } }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
  blindIndex: (s: string) => `h:${s}`,
}));

const ORG = "org-1";
const CUST = "cust-1";

beforeEach(() => vi.clearAllMocks());

function mockSelectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as never);
}

describe("upsertCustomerLocation", () => {
  it("returns the existing location id when the address already exists (dedupe)", async () => {
    mockSelectOnce([{ id: "loc-existing" }]);
    const id = await upsertCustomerLocation(ORG, CUST, { address: "123 Main St" });
    expect(id).toBe("loc-existing");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts and returns a new location id when the address is new", async () => {
    mockSelectOnce([]); // no existing
    const returning = vi.fn().mockResolvedValue([{ id: "loc-new" }]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({ returning }),
      }),
    } as never);

    const id = await upsertCustomerLocation(ORG, CUST, {
      address: "456 Oak Ave",
      label: "rental",
    });
    expect(id).toBe("loc-new");
  });

  function mockInsertNew() {
    const returning = vi.fn().mockResolvedValue([{ id: "loc-new" }]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({ returning }),
      }),
    } as never);
  }

  it("marks the first location primary with a guarded UPDATE and returns the id", async () => {
    mockSelectOnce([]); // no existing by hash
    mockInsertNew();
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).resolves.toBe("loc-new");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("swallows a lost primary race (wrapped 23505)", async () => {
    mockSelectOnce([]);
    mockInsertNew();
    vi.mocked(db.execute).mockRejectedValueOnce(
      Object.assign(new Error("q"), {
        cause: { code: "23505", constraint: "customer_locations_one_primary_idx" },
      }),
    );
    await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).resolves.toBe("loc-new");
  });

  it("rethrows a non-unique error from the primary UPDATE", async () => {
    mockSelectOnce([]);
    mockInsertNew();
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("boom"));
    await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).rejects.toThrow("boom");
  });
});

describe("getEquipmentServiceHistory", () => {
  it("returns the per-asset timeline newest-first", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([
            {
              id: "h1",
              serviceRequestId: "r1",
              workPerformed: "replaced capacitor",
              partsUsed: "cap",
              cost: 12000,
              createdAt: new Date("2026-01-01T00:00:00Z"),
            },
          ]),
        }),
      }),
    } as never);

    const history = await getEquipmentServiceHistory(ORG, "equip-1");
    expect(history).toHaveLength(1);
    expect(history[0]!.workPerformed).toBe("replaced capacitor");
    expect(history[0]!.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("setPrimaryLocation", () => {
  it("returns false when the location is not the customer's", async () => {
    mockSelectOnce([]);
    await expect(setPrimaryLocation(ORG, CUST, "loc-x")).resolves.toBe(false);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("batches the unset statement before the set statement", async () => {
    mockSelectOnce([{ id: "loc-1" }]);
    const order: string[] = [];
    const stmt = (label: string, isPrimary: boolean) => ({
      set: vi.fn((v: { isPrimary: boolean }) => {
        expect(v.isPrimary).toBe(isPrimary);
        return { where: vi.fn(() => { order.push(label); return { label }; }) };
      }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(stmt("unset", false) as never)
      .mockReturnValueOnce(stmt("set", true) as never);
    vi.mocked(db.batch).mockResolvedValueOnce([] as never);
    await expect(setPrimaryLocation(ORG, CUST, "loc-1")).resolves.toBe(true);
    const arg = vi.mocked(db.batch).mock.calls[0]![0] as unknown as { label: string }[];
    expect(arg.map((a) => a.label)).toEqual(["unset", "set"]);
    expect(order).toEqual(["unset", "set"]);
  });

  it("maps a wrapped 23505 on the primary index to a race", async () => {
    mockSelectOnce([{ id: "loc-1" }]);
    const chain = { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({}) }) };
    vi.mocked(db.update).mockReturnValue(chain as never);
    vi.mocked(db.batch).mockRejectedValueOnce(
      Object.assign(new Error("q"), { cause: { code: "23505", constraint: "customer_locations_one_primary_idx" } }),
    );
    await expect(setPrimaryLocation(ORG, CUST, "loc-1")).resolves.toEqual({ reason: "race" });
  });
});
