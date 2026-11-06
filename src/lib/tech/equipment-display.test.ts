import { describe, it, expect } from "vitest";
import { emptyForm, formBody, formForReplace, replaceHeading, unitDescription, unitDetails } from "./equipment-display";

const unit = { id: "u1", equipmentType: "ac", make: "Carrier", model: "24ACC6", serialNumber: "S123", locationInHome: null, notes: null, installDate: null, managedExternally: false };

describe("equipment display (spec §7.5)", () => {
  it("Replacing <make> <type in lower case>", () => {
    expect(replaceHeading(unit)).toBe("Replacing Carrier air conditioner");
    expect(replaceHeading({ ...unit, make: null, equipmentType: "furnace" })).toBe("Replacing furnace");
  });
  it("details line", () => {
    expect(unitDetails(unit)).toBe("Carrier · 24ACC6 · S/N S123");
    expect(unitDetails({ ...unit, make: null, model: null, serialNumber: null })).toBe("");
  });
  it("replace pre-fills the old unit's type only", () => {
    expect(formForReplace(unit)).toEqual({ ...emptyForm(), equipmentType: "ac" });
  });
  it("the POST body drops blanks, trims, and carries replacesId", () => {
    expect(formBody({ ...emptyForm(), equipmentType: "ac", make: "  Trane ", model: " " }, "u1")).toEqual({ equipmentType: "ac", make: "Trane", replacesId: "u1" });
    expect(formBody({ ...emptyForm(), equipmentType: "other", notes: "Humidifier", installDate: "2026-11-06" }, null))
      .toEqual({ equipmentType: "other", notes: "Humidifier", installDate: "2026-11-06" });
  });
});

describe("the Other description is shown (final review B P1-3)", () => {
  it("Other shows its 'Describe it' text", () => {
    expect(unitDescription({ equipmentType: "other", notes: " Whole-home dehumidifier " })).toBe("Whole-home dehumidifier");
  });
  it("other types and blank notes show nothing extra", () => {
    expect(unitDescription({ equipmentType: "ac", notes: "Office note" })).toBeNull();
    expect(unitDescription({ equipmentType: "other", notes: "  " })).toBeNull();
    expect(unitDescription({ equipmentType: "other", notes: null })).toBeNull();
  });
});
