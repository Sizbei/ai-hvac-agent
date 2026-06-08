import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectResult, insertSpy, updateSpy } = vi.hoisted(() => ({
  selectResult: { value: [] as unknown[] },
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResult.value) }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        insertSpy(v);
        return { returning: () => Promise.resolve([{ id: "eq-new" }]) };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        updateSpy(v);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  customerEquipment: {
    id: "eq.id",
    customerId: "eq.customerId",
    equipmentType: "eq.equipmentType",
    make: "eq.make",
    installDate: "eq.installDate",
    organizationId: "eq.org",
  },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, _o: string, ...c: unknown[]) => c[0] ?? true,
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

import { recordCustomerEquipment } from "./crm-equipment-queries";

const ORG = "org-1";
const CUST = "cust-1";

describe("recordCustomerEquipment", () => {
  beforeEach(() => {
    selectResult.value = [];
    insertSpy.mockReset();
    updateSpy.mockReset();
  });

  it("inserts a new equipment row when the customer has none of that type", async () => {
    selectResult.value = []; // no existing
    const r = await recordCustomerEquipment(ORG, CUST, {
      equipmentType: "heat_pump",
      make: "Trane",
      installDate: new Date("2014-06-10T00:00:00Z"),
    });
    expect(r).toEqual({ id: "eq-new", created: true });
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: CUST,
        equipmentType: "heat_pump",
        make: "Trane",
      }),
    );
  });

  it("does NOT insert a duplicate; enriches the existing row's empty fields", async () => {
    selectResult.value = [{ id: "eq-1", make: null, installDate: null }];
    const r = await recordCustomerEquipment(ORG, CUST, {
      equipmentType: "ac",
      make: "Lennox",
      installDate: new Date("2019-06-10T00:00:00Z"),
    });
    expect(r).toEqual({ id: "eq-1", created: false });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ make: "Lennox" }),
    );
  });

  it("never clobbers an already-known make/install date", async () => {
    selectResult.value = [
      { id: "eq-1", make: "Carrier", installDate: new Date("2010-01-01") },
    ];
    const r = await recordCustomerEquipment(ORG, CUST, {
      equipmentType: "ac",
      make: "Lennox",
      installDate: new Date("2019-06-10T00:00:00Z"),
    });
    expect(r.created).toBe(false);
    // Nothing new to fill → no update issued.
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
