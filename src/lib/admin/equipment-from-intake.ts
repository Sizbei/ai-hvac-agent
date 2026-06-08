/**
 * Map the intake's system/equipment fields into a customer_equipment row.
 *
 * A ServiceTitan backbone: when a conversation tells us the system type (and
 * maybe brand + age), we record an equipment asset against the customer so a
 * service history accrues per unit. Pure (no I/O); the install date is
 * approximated from the coarse age band — `now` is passed in so it stays
 * deterministic and testable.
 */

type SystemType =
  | "central_ac"
  | "furnace"
  | "heat_pump"
  | "mini_split"
  | "boiler"
  | "packaged_unit"
  | "other";

type EquipmentType =
  | "ac"
  | "furnace"
  | "heat_pump"
  | "boiler"
  | "mini_split"
  | "thermostat"
  | "other";

type AgeBand = "under_5" | "5_to_10" | "10_to_15" | "over_15" | "unknown";

// Intake system type → customer_equipment.equipment_type. packaged_unit (a
// rooftop combo) has no dedicated enum member, so it maps to "other".
const SYSTEM_TO_EQUIPMENT: Record<SystemType, EquipmentType> = {
  central_ac: "ac",
  furnace: "furnace",
  heat_pump: "heat_pump",
  mini_split: "mini_split",
  boiler: "boiler",
  packaged_unit: "other",
  other: "other",
};

export function systemTypeToEquipmentType(
  systemType: string | null | undefined,
): EquipmentType | null {
  if (!systemType) return null;
  return SYSTEM_TO_EQUIPMENT[systemType as SystemType] ?? null;
}

// Midpoint age (in years) for each band, used to approximate an install date.
const BAND_MIDPOINT_YEARS: Record<Exclude<AgeBand, "unknown">, number> = {
  under_5: 2,
  "5_to_10": 7,
  "10_to_15": 12,
  over_15: 18,
};

/** Approximate an install date from the age band (midpoint years before `now`). */
export function ageBandToInstallDate(
  ageBand: string | null | undefined,
  now: Date,
): Date | null {
  if (!ageBand || ageBand === "unknown") return null;
  const years = BAND_MIDPOINT_YEARS[ageBand as Exclude<AgeBand, "unknown">];
  if (years === undefined) return null;
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export interface IntakeEquipmentInput {
  readonly systemType?: string | null;
  readonly equipmentBrand?: string | null;
  readonly equipmentAgeBand?: string | null;
}

export interface BuiltEquipment {
  readonly equipmentType: EquipmentType;
  readonly make: string | null;
  readonly installDate: Date | null;
}

/**
 * Build a customer_equipment payload from intake fields, or null when there's
 * no system type (nothing worth recording — brand/age alone don't identify a
 * unit).
 */
export function buildEquipmentFromIntake(
  intake: IntakeEquipmentInput,
  now: Date,
): BuiltEquipment | null {
  const equipmentType = systemTypeToEquipmentType(intake.systemType);
  if (equipmentType === null) return null;
  return {
    equipmentType,
    make: intake.equipmentBrand?.trim() || null,
    installDate: ageBandToInstallDate(intake.equipmentAgeBand, now),
  };
}
