import { describe, it, expect } from "vitest";
import {
  systemTypeToEquipmentType,
  ageBandToInstallDate,
  buildEquipmentFromIntake,
} from "./equipment-from-intake";

describe("systemTypeToEquipmentType", () => {
  it("maps intake system types to customer_equipment enum values", () => {
    expect(systemTypeToEquipmentType("central_ac")).toBe("ac");
    expect(systemTypeToEquipmentType("furnace")).toBe("furnace");
    expect(systemTypeToEquipmentType("heat_pump")).toBe("heat_pump");
    expect(systemTypeToEquipmentType("mini_split")).toBe("mini_split");
    expect(systemTypeToEquipmentType("boiler")).toBe("boiler");
  });
  it("maps packaged_unit and other to 'other'", () => {
    expect(systemTypeToEquipmentType("packaged_unit")).toBe("other");
    expect(systemTypeToEquipmentType("other")).toBe("other");
  });
  it("returns null for an unknown/absent system type", () => {
    expect(systemTypeToEquipmentType(null)).toBeNull();
    expect(systemTypeToEquipmentType("spaceship")).toBeNull();
  });
});

describe("ageBandToInstallDate", () => {
  const NOW = new Date("2026-06-10T00:00:00Z");
  it("approximates an install date from the age band (midpoint years ago)", () => {
    // under_5 → ~2 yrs ago, 5_to_10 → ~7, 10_to_15 → ~12, over_15 → ~18
    expect(ageBandToInstallDate("under_5", NOW)?.getUTCFullYear()).toBe(2024);
    expect(ageBandToInstallDate("5_to_10", NOW)?.getUTCFullYear()).toBe(2019);
    expect(ageBandToInstallDate("10_to_15", NOW)?.getUTCFullYear()).toBe(2014);
    expect(ageBandToInstallDate("over_15", NOW)?.getUTCFullYear()).toBe(2008);
  });
  it("returns null for unknown/absent", () => {
    expect(ageBandToInstallDate("unknown", NOW)).toBeNull();
    expect(ageBandToInstallDate(null, NOW)).toBeNull();
  });
});

describe("buildEquipmentFromIntake", () => {
  const NOW = new Date("2026-06-10T00:00:00Z");
  it("returns null when there is no system type (nothing to record)", () => {
    expect(
      buildEquipmentFromIntake(
        { systemType: null, equipmentBrand: "Trane", equipmentAgeBand: "5_to_10" },
        NOW,
      ),
    ).toBeNull();
  });

  it("builds an equipment row from system type + brand + age band", () => {
    const eq = buildEquipmentFromIntake(
      {
        systemType: "heat_pump",
        equipmentBrand: "Trane",
        equipmentAgeBand: "10_to_15",
      },
      NOW,
    );
    expect(eq).not.toBeNull();
    expect(eq!.equipmentType).toBe("heat_pump");
    expect(eq!.make).toBe("Trane");
    expect(eq!.installDate?.getUTCFullYear()).toBe(2014);
  });

  it("omits make/installDate when brand/age are absent", () => {
    const eq = buildEquipmentFromIntake({ systemType: "furnace" }, NOW);
    expect(eq!.equipmentType).toBe("furnace");
    expect(eq!.make).toBeNull();
    expect(eq!.installDate).toBeNull();
  });
});
