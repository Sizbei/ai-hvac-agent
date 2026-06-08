/**
 * Customer-equipment CRUD queries, split out of crm-queries.ts to keep that
 * file under the project's file-size ceiling. Every query is scoped to BOTH the
 * org and the parent customer so a mismatched (customerId, equipmentId) pair —
 * or a cross-tenant id — can never touch another customer's record.
 */
import { and, eq } from "drizzle-orm";
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

export interface RecordEquipmentInput {
  readonly equipmentType: EquipmentType;
  readonly make: string | null;
  readonly installDate: Date | null;
}

/**
 * Record a customer's equipment captured from a service-intake conversation,
 * de-duplicated by equipment TYPE: if the customer already has a unit of that
 * type we enrich the existing row with any newly-learned make/install date
 * (never overwriting a known value with null) rather than inserting a duplicate;
 * otherwise we insert a new row. Org + customer scoped. Returns the row id and
 * whether it was created or updated.
 */
export async function recordCustomerEquipment(
  organizationId: string,
  customerId: string,
  input: RecordEquipmentInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const [existing] = await db
    .select({
      id: customerEquipment.id,
      make: customerEquipment.make,
      installDate: customerEquipment.installDate,
    })
    .from(customerEquipment)
    .where(
      withTenant(
        customerEquipment,
        organizationId,
        and(
          eq(customerEquipment.customerId, customerId),
          eq(customerEquipment.equipmentType, input.equipmentType),
        )!,
      ),
    )
    .limit(1);

  if (existing) {
    // Enrich only the gaps — never clobber an already-known make/install date.
    const patch: { make?: string; installDate?: Date; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (!existing.make && input.make) patch.make = input.make;
    if (!existing.installDate && input.installDate) {
      patch.installDate = input.installDate;
    }
    if (patch.make !== undefined || patch.installDate !== undefined) {
      await db
        .update(customerEquipment)
        .set(patch)
        .where(
          withTenant(
            customerEquipment,
            organizationId,
            eq(customerEquipment.id, existing.id),
          ),
        );
    }
    return { id: existing.id, created: false };
  }

  const [inserted] = await db
    .insert(customerEquipment)
    .values({
      organizationId,
      customerId,
      equipmentType: input.equipmentType,
      make: input.make,
      installDate: input.installDate,
    })
    .returning({ id: customerEquipment.id });

  return { id: inserted!.id, created: true };
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
