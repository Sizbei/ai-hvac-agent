import { describe, it, expect } from "vitest";
import {
  humanizeCode,
  issueTypeLabel,
  noteTypeLabel,
  equipmentTypeLabel,
  NOTE_TYPE_OPTIONS,
  EQUIPMENT_TYPE_OPTIONS,
} from "./display-labels";

describe("humanizeCode", () => {
  it("turns snake case into sentence case", () => {
    expect(humanizeCode("follow_up")).toBe("Follow up");
    expect(humanizeCode("COOLING_NOT_WORKING")).toBe("Cooling not working");
    expect(humanizeCode("")).toBe("");
    expect(humanizeCode(null)).toBe("");
  });

  it("shows free text (FieldPulse job titles) as written", () => {
    expect(humanizeCode("Job for Hollow Creek Community Chapel")).toBe(
      "Job for Hollow Creek Community Chapel",
    );
    expect(humanizeCode("HVAC DOWN")).toBe("HVAC DOWN");
    expect(humanizeCode("HVAC")).toBe("HVAC");
    expect(humanizeCode("  Ice  Machine ")).toBe("Ice Machine");
    expect(humanizeCode("hccc open door classroom")).toBe("hccc open door classroom");
    expect(issueTypeLabel("Lazy Lady Baking Company")).toBe("Lazy Lady Baking Company");
    expect(humanizeCode("refrigeration")).toBe("Refrigeration");
    expect(issueTypeLabel("Marlow's Deli Ashgrove: HVAC")).toBe("Marlow's Deli Ashgrove: HVAC");
  });
});

describe("issueTypeLabel", () => {
  it.each([
    ["water_leak", "Water leak"],
    ["thermostat_issue", "Thermostat"],
    ["cooling_not_working", "Cooling not working"],
    ["air_quality", "Indoor air quality"],
    ["maintenance", "Maintenance"],
  ])("labels %s", (code, label) => {
    expect(issueTypeLabel(code)).toBe(label);
  });
  it("humanizes unknown codes and falls back when empty", () => {
    expect(issueTypeLabel("duct_cleaning")).toBe("Duct cleaning");
    expect(issueTypeLabel(null)).toBe("Service request");
    expect(issueTypeLabel("")).toBe("Service request");
  });
});

describe("noteTypeLabel / equipmentTypeLabel", () => {
  it("labels every option and never echoes a raw code", () => {
    for (const o of NOTE_TYPE_OPTIONS) expect(noteTypeLabel(o.value)).not.toContain("_");
    for (const o of EQUIPMENT_TYPE_OPTIONS) expect(equipmentTypeLabel(o.value)).not.toContain("_");
    expect(noteTypeLabel("follow_up")).toBe("Follow up");
    expect(equipmentTypeLabel("heat_pump")).toBe("Heat pump");
    expect(equipmentTypeLabel("ac")).toBe("Air conditioner");
  });
  it("labels are sentence case", () => {
    for (const o of [...NOTE_TYPE_OPTIONS, ...EQUIPMENT_TYPE_OPTIONS]) {
      expect(o.label.slice(1)).toBe(o.label.slice(1).toLowerCase());
    }
  });
});
