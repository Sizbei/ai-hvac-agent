/**
 * Customer-equipment CRUD queries, split out of crm-queries.ts to keep that
 * file under the project's file-size ceiling. Every query is scoped to BOTH the
 * org and the parent customer so a mismatched (customerId, equipmentId) pair —
 * or a cross-tenant id — can never touch another customer's record.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerEquipment } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  UpdateEquipmentInput,
  UpdateEquipmentResult,
} from "./crm-types";

/** Valid equipment_type enum values. Exported so the API layer can validate a
 * type before it reaches the DB (a raw pg enum violation would otherwise 500). */
export const EQUIPMENT_TYPES = [
  "ac",
  "furnace",
  "heat_pump",
  "boiler",
  "mini_split",
  "thermostat",
  "other",
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export function isEquipmentType(value: string): value is EquipmentType {
  return (EQUIPMENT_TYPES as readonly string[]).includes(value);
}

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Update an equipment row. Partial patch: only provided keys are written; for
 * nullable columns, `null` clears and an absent key is left untouched.
 * equipmentType is validated against the enum (returns `invalid_type`). On
 * success returns the exact set of columns written so the caller's audit trail
 * reflects what truly changed.
 */
export async function updateEquipment(
  organizationId: string,
  customerId: string,
  equipmentId: string,
  input: UpdateEquipmentInput,
): Promise<UpdateEquipmentResult> {
  const updates: Record<string, unknown> = {};

  if (input.equipmentType !== undefined) {
    if (!isEquipmentType(input.equipmentType)) {
      return { ok: false, reason: "invalid_type" };
    }
    updates.equipmentType = input.equipmentType;
  }
  if (input.make !== undefined) updates.make = input.make;
  if (input.model !== undefined) updates.model = input.model;
  if (input.serialNumber !== undefined) updates.serialNumber = input.serialNumber;
  if (input.installDate !== undefined) {
    updates.installDate = parseDateOrNull(input.installDate);
  }
  if (input.warrantyExpiration !== undefined) {
    updates.warrantyExpiration = parseDateOrNull(input.warrantyExpiration);
  }
  if (input.locationInHome !== undefined) {
    updates.locationInHome = input.locationInHome;
  }
  if (input.notes !== undefined) updates.notes = input.notes;

  if (Object.keys(updates).length === 0) {
    return { ok: false, reason: "no_changes" };
  }

  const [updated] = await db
    .update(customerEquipment)
    .set(updates)
    .where(
      withTenant(
        customerEquipment,
        organizationId,
        eq(customerEquipment.id, equipmentId),
        eq(customerEquipment.customerId, customerId),
      ),
    )
    .returning({ id: customerEquipment.id });

  if (!updated) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, updatedFields: Object.keys(updates) };
}

/**
 * Delete an equipment row, scoped to the org and parent customer. Returns false
 * if no matching row exists (wrong org, wrong customer, or already deleted).
 */
export async function deleteEquipment(
  organizationId: string,
  customerId: string,
  equipmentId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(customerEquipment)
    .where(
      withTenant(
        customerEquipment,
        organizationId,
        eq(customerEquipment.id, equipmentId),
        eq(customerEquipment.customerId, customerId),
      ),
    )
    .returning({ id: customerEquipment.id });

  return Boolean(deleted);
}
