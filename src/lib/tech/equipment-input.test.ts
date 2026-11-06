import { describe, it, expect } from "vitest";
import { EQUIPMENT_TYPE_VALUES, noonInZone, parseEquipmentInput, todayInZone } from "./equipment-input";
import { EQUIPMENT_TYPE_OPTIONS } from "@/lib/admin/display-labels";

const TODAY = "2026-11-06";
const ok = (raw: Record<string, unknown>) => parseEquipmentInput(raw, TODAY);

describe("parseEquipmentInput (spec §5.6)", () => {
  it("type values match the shared labels", () => {
    expect([...EQUIPMENT_TYPE_VALUES]).toEqual(EQUIPMENT_TYPE_OPTIONS.map((o) => o.value));
  });
  it("trims, blanks become null, ids lower-cased", () => {
    expect(ok({ equipmentType: "ac", make: "  Carrier ", model: " ", replacesId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })).toEqual({
      ok: true,
      value: { equipmentType: "ac", make: "Carrier", model: null, serialNumber: null, locationInHome: null, notes: null, installDate: null, replacesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });
  it("refuses an unknown type, a missing Other description, long text, bad dates and a bad replaces id", () => {
    expect(ok({ equipmentType: "jacuzzi" })).toEqual({ ok: false, error: "type" });
    expect(ok({ equipmentType: "other", notes: "  " })).toEqual({ ok: false, error: "describe" });
    expect(ok({ equipmentType: "other", notes: "Humidifier" }).ok).toBe(true);
    expect(ok({ equipmentType: "ac", serialNumber: "x".repeat(121) })).toEqual({ ok: false, error: "too_long" });
    expect(ok({ equipmentType: "ac", serialNumber: "x".repeat(120) }).ok).toBe(true);
    expect(ok({ equipmentType: "ac", installDate: "2026-02-30" })).toEqual({ ok: false, error: "date_invalid" });
    expect(ok({ equipmentType: "ac", installDate: "11/06/2026" })).toEqual({ ok: false, error: "date_invalid" });
    expect(ok({ equipmentType: "ac", installDate: "2026-11-07" })).toEqual({ ok: false, error: "date_future" });
    expect(ok({ equipmentType: "ac", replacesId: "nope" })).toEqual({ ok: false, error: "replaces" });
  });
  it("parseEquipmentInput accepts today in the business timezone at 23:30 Eastern", () => {
    const today = todayInZone(new Date("2026-11-07T04:30:00Z")); // 23:30 EST on Nov 6
    expect(today).toBe("2026-11-06");
    expect(parseEquipmentInput({ equipmentType: "furnace", installDate: "2026-11-06" }, today).ok).toBe(true);
    expect(parseEquipmentInput({ equipmentType: "furnace", installDate: "2026-11-07" }, today)).toEqual({ ok: false, error: "date_future" });
  });
});

describe("noonInZone", () => {
  it("noonInZone is noon Eastern on both sides of the DST change", () => {
    expect(noonInZone("2026-11-06").toISOString()).toBe("2026-11-06T17:00:00.000Z");
    expect(noonInZone("2026-07-04").toISOString()).toBe("2026-07-04T16:00:00.000Z");
    expect(noonInZone("2026-11-01").toISOString()).toBe("2026-11-01T17:00:00.000Z"); // DST ends that morning
    expect(noonInZone("2026-03-08").toISOString()).toBe("2026-03-08T16:00:00.000Z"); // DST starts that morning
  });
});
