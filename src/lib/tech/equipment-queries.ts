/**
 * The job page's Equipment card read model (M3c spec §6): the customer's live
 * units by the location rule, and whether the caller may add or replace.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { findReadableJob } from "@/lib/tech/ownership";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";
import { locationRuleSql, onJobSql } from "@/lib/tech/equipment-writes";
import type { TechEquipmentUnit, TechEquipmentView } from "@/lib/tech/equipment-input";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function unitsSql(org: string, rid: string): SQL {
  return sql`SELECT ce.id, ce.equipment_type::text AS equipment_type, ce.make, ce.model, ce.serial_number, ce.location_in_home,
      ce.notes, ce.install_date, ce.fieldpulse_asset_id IS NOT NULL AS managed_externally
    FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE ce.organization_id = ${org}::uuid AND ce.customer_id = r.customer_id AND ce.retired_at IS NULL AND ${locationRuleSql("ce", "r")}
    ORDER BY ce.created_at, ce.id`;
}

export function canWriteSql(org: string, rid: string, me: string): SQL {
  return sql`SELECT (${onJobSql(org, rid, me)}) AS on_job, r.status::text AS status, r.customer_id IS NOT NULL AS has_customer
    FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export function canWriteFrom(row: Row | undefined): boolean {
  return row?.on_job === true && row.has_customer === true
    && (BILL_STATUSES as readonly string[]).includes(String(row.status));
}

export function toUnit(r: Row): TechEquipmentUnit {
  return {
    id: String(r.id), equipmentType: String(r.equipment_type), make: str(r.make), model: str(r.model),
    serialNumber: str(r.serial_number), locationInHome: str(r.location_in_home), notes: str(r.notes),
    installDate: r.install_date ? new Date(r.install_date as string | Date).toISOString() : null,
    managedExternally: r.managed_externally === true,
  };
}

export async function getTechEquipmentView(
  org: string, me: string, rid: string,
): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEquipmentView }> {
  const job = await findReadableJob(org, me, rid);
  if (!job) return { kind: "not_found" };
  if (!job.native) return { kind: "external" };
  const [units, gate] = await Promise.all([
    db.execute(unitsSql(org, rid)),
    db.execute(canWriteSql(org, rid, me)),
  ]);
  return {
    kind: "ok",
    view: { units: (units.rows as Row[]).map(toUnit), canWrite: canWriteFrom((gate.rows as Row[])[0]) },
  };
}
