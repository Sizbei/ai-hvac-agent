/**
 * The customer profile's equipment list (M3c spec §2): live units first, then
 * retired ones; the replacement link only when that unit still exists; the
 * count covers live units only. Pure.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { EquipmentRecord } from "./crm-types";

export interface EquipmentRowLike {
  readonly id: string; readonly equipmentType: string; readonly make: string | null; readonly model: string | null;
  readonly serialNumber: string | null; readonly installDate: Date | null; readonly warrantyExpiration: Date | null;
  readonly warrantyType: string | null; readonly warrantyProvider: string | null; readonly locationInHome: string | null;
  readonly notes: string | null; readonly fieldpulseAssetId: string | null;
  readonly retiredAt?: Date | null; readonly replacedByEquipmentId?: string | null;
}

export function equipmentRecords(rows: readonly EquipmentRowLike[]): EquipmentRecord[] {
  const ids = new Set(rows.map((r) => r.id));
  const live = rows.filter((r) => !r.retiredAt);
  const retired = rows.filter((r) => r.retiredAt);
  return [...live, ...retired].map((e) => ({
    id: e.id,
    equipmentType: e.equipmentType,
    make: e.make,
    model: e.model,
    serialNumber: e.serialNumber,
    installDate: e.installDate?.toISOString() ?? null,
    warrantyExpiration: e.warrantyExpiration?.toISOString() ?? null,
    warrantyType: e.warrantyType,
    warrantyProvider: e.warrantyProvider,
    locationInHome: e.locationInHome,
    notes: e.notes,
    fieldpulseAssetId: e.fieldpulseAssetId ?? null,
    retiredAt: e.retiredAt ? e.retiredAt.toISOString() : null,
    replacedByEquipmentId: e.replacedByEquipmentId && ids.has(e.replacedByEquipmentId) ? e.replacedByEquipmentId : null,
  }));
}

export function liveEquipmentCount(rows: readonly { readonly retiredAt?: Date | null }[]): number {
  return rows.filter((r) => !r.retiredAt).length;
}

export function replacedOnLabel(iso: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  return `Replaced ${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))}`;
}
