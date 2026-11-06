/** Equipment card / sheet copy and form mapping (M3c spec §7.5). Pure. */
import { equipmentTypeLabel } from "@/lib/admin/display-labels";
import type { TechEquipmentUnit } from "./equipment-input";

export const EQUIPMENT_COPY = {
  title: "Equipment",
  add: "Add equipment",
  replace: "Replace",
  managed: "Managed in FieldPulse",
  empty: "No equipment recorded at this address.",
  type: "Type",
  make: "Make",
  model: "Model",
  serial: "Serial number",
  location: "Location in home",
  installDate: "Install date",
  describe: "Describe it",
  save: "Save",
  saving: "Saving…",
  sheetDescription: "Record the unit at this address.",
  loadError: "Couldn't load the equipment at this address.",
} as const;

export function unitDetails(u: Pick<TechEquipmentUnit, "make" | "model" | "serialNumber">): string {
  return [u.make, u.model, u.serialNumber ? `S/N ${u.serialNumber}` : null].filter(Boolean).join(" · ");
}

/** The "Describe it" text of an Other unit, shown under its type (final review B P1-3); null otherwise. */
export function unitDescription(u: Pick<TechEquipmentUnit, "equipmentType" | "notes">): string | null {
  const d = u.equipmentType === "other" ? u.notes?.trim() ?? "" : "";
  return d === "" ? null : d;
}

export function replaceHeading(u: Pick<TechEquipmentUnit, "make" | "equipmentType">): string {
  return `Replacing ${u.make ? `${u.make} ` : ""}${equipmentTypeLabel(u.equipmentType).toLowerCase()}`;
}

export interface EquipmentForm {
  readonly equipmentType: string;
  readonly make: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly locationInHome: string;
  readonly installDate: string;
  readonly notes: string;
}

export function emptyForm(): EquipmentForm {
  return { equipmentType: "", make: "", model: "", serialNumber: "", locationInHome: "", installDate: "", notes: "" };
}

export function formForReplace(u: Pick<TechEquipmentUnit, "equipmentType">): EquipmentForm {
  return { ...emptyForm(), equipmentType: u.equipmentType };
}

/** Non-blank trimmed fields only; `notes` only for Other (the sheet hides it otherwise). */
export function formBody(f: EquipmentForm, replacesId: string | null): Record<string, string> {
  const out: Record<string, string> = { equipmentType: f.equipmentType };
  const put = (k: keyof EquipmentForm) => {
    const v = f[k].trim();
    if (v !== "") out[k] = v;
  };
  put("make");
  put("model");
  put("serialNumber");
  put("locationInHome");
  put("installDate");
  if (f.equipmentType === "other") put("notes");
  if (replacesId) out.replacesId = replacesId;
  return out;
}
