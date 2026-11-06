import { describe, it, expect } from "vitest";
import {
  equipmentDetailsLine, equipmentRecords, equipmentRowActions, liveEquipmentCount, replacedOnLabel, type EquipmentRowLike,
} from "./crm-equipment-records";

const row = (id: string, over: Partial<EquipmentRowLike> = {}): EquipmentRowLike => ({
  id, equipmentType: "ac", make: null, model: null, serialNumber: null, installDate: null, warrantyExpiration: null,
  warrantyType: null, warrantyProvider: null, locationInHome: null, notes: null, fieldpulseAssetId: null,
  retiredAt: null, replacedByEquipmentId: null, ...over,
});

describe("office equipment list (spec §2)", () => {
  it("retired units sort last; the replacement link is null-safe; the count is live units only", () => {
    const rows = [
      row("old", { retiredAt: new Date("2026-11-06T17:00:00Z"), replacedByEquipmentId: "new" }),
      row("new"),
      row("gone-link", { retiredAt: new Date("2026-10-01T17:00:00Z"), replacedByEquipmentId: "deleted" }),
      row("live2"),
    ];
    const out = equipmentRecords(rows);
    expect(out.map((r) => r.id)).toEqual(["new", "live2", "old", "gone-link"]);
    expect(out[2]).toMatchObject({ retiredAt: "2026-11-06T17:00:00.000Z", replacedByEquipmentId: "new" });
    expect(out[3]!.replacedByEquipmentId).toBeNull();
    expect(liveEquipmentCount(rows)).toBe(2);
  });
  it("office retired label in the business timezone", () => {
    expect(replacedOnLabel("2026-11-06T17:00:00.000Z")).toBe("Replaced Nov 6, 2026");
    expect(replacedOnLabel("2026-11-07T03:00:00.000Z")).toBe("Replaced Nov 6, 2026"); // 22:00 Eastern
  });
});

describe("office equipment row (final review B P1-3, Task 10 parked)", () => {
  const rec = (over: Partial<EquipmentRowLike>) => equipmentRecords([row("u1", over)])[0]!;
  it("an Other unit reads its description instead of 'No details'", () => {
    expect(equipmentDetailsLine(rec({ equipmentType: "other", notes: "Whole-home dehumidifier" }))).toBe("Whole-home dehumidifier");
    expect(equipmentDetailsLine(rec({ equipmentType: "other", make: "Aprilaire", notes: "Whole-home dehumidifier" })))
      .toBe("Whole-home dehumidifier · Aprilaire");
  });
  it("make, model and serial as before; nothing at all reads 'No details'", () => {
    expect(equipmentDetailsLine(rec({ make: "Carrier", model: "24ACC6", serialNumber: "S1" }))).toBe("Carrier 24ACC6 — S/N: S1");
    expect(equipmentDetailsLine(rec({}))).toBe("No details");
  });
  it("a retired unit is read-only: no Edit, Delete stays behind its confirm", () => {
    expect(equipmentRowActions(rec({ retiredAt: new Date("2026-11-06T15:00:00Z") }))).toEqual({ edit: false, delete: true });
    expect(equipmentRowActions(rec({}))).toEqual({ edit: true, delete: true });
  });
});
