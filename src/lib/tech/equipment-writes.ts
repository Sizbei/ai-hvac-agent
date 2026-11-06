/**
 * Field equipment add / replace (M3c spec §5.6). ONE db.batch: L_req, then (for
 * a replace) the old row's lock, the guarded INSERT, the xmin-gated retire and
 * a tail read; every statement repeats the caller-on-the-job check and
 * `service_requests.customer_id = $cust`.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";
import { noonInZone, type EquipmentInput } from "@/lib/tech/equipment-input";

export type EquipmentReason = "no_customer" | "not_found" | "equipment_retired" | "managed_externally" | "stale";
export type EquipmentWriteResult =
  | { ok: true; equipmentId: string; created: boolean; replaced: boolean }
  | { ok: false; reason: EquipmentReason };

type Row = Record<string, unknown>;
const fail = (reason: EquipmentReason): EquipmentWriteResult => ({ ok: false, reason });
const BILL_IN = statusInSql(BILL_STATUSES);

/** Shared by the GET and every write: request without a location → any unit; else the same location or none. */
export function locationRuleSql(unit: string, req: string): SQL {
  return sql.raw(`(${req}.location_id IS NULL OR ${unit}.location_id IS NULL OR ${unit}.location_id = ${req}.location_id)`);
}

/** The caller holds a non-cancelled assignment on a non-cancelled visit of the request. */
export function onJobSql(org: string, rid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id
    WHERE p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND a.organization_id = ${org}::uuid
      AND p.cancelled_at IS NULL AND a.technician_id = ${me}::uuid AND a.status <> 'cancelled'::request_status)`;
}

export function replaceOutcome(old: Row | undefined, newId: string): EquipmentWriteResult {
  if (!old) return fail("not_found");
  if (String(old.replaced_by_equipment_id ?? "").toLowerCase() === newId.toLowerCase()) {
    return { ok: true, equipmentId: newId, created: false, replaced: true };
  }
  if (old.retired === true) return fail("equipment_retired");
  if (old.synced === true) return fail("managed_externally");
  // Visible, live and native, yet nothing was written: the request changed under
  // the batch (status, assignment, customer). Plan ruling 15: STALE, not 404.
  return fail("stale");
}

export async function addFieldEquipment(
  actor: { organizationId: string; requestId: string; techUserId: string },
  ids: { equipmentId: string },
  input: EquipmentInput,
): Promise<EquipmentWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const neu = ids.equipmentId;
  const [req] = await readRows(sql`SELECT customer_id FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return fail("stale");
  const cust = (req.customer_id as string | null) ?? null;
  if (cust === null) return fail("no_customer");

  const onJob = onJobSql(org, rid, me);
  const reqOk = sql`r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.customer_id = ${cust}::uuid AND r.status IN ${BILL_IN} AND (${onJob})`;
  const installAt = input.installDate ? noonInZone(input.installDate).toISOString() : null;
  const insertNew = (extra: SQL): SQL => sql`INSERT INTO customer_equipment (id, organization_id, customer_id, location_id, equipment_type, make, model, serial_number, location_in_home, notes, install_date)
      SELECT ${neu}::uuid, ${org}::uuid, ${cust}::uuid, r.location_id, ${input.equipmentType}::equipment_type, ${input.make}::text, ${input.model}::text,
        ${input.serialNumber}::text, ${input.locationInHome}::text, ${input.notes}::text, ${installAt}::timestamptz
      FROM service_requests r WHERE ${reqOk}${extra}
      ON CONFLICT (id) DO NOTHING RETURNING id`;

  if (input.replacesId === null) {
    const rows = await runBatch([
      lockRequestSql(org, rid),
      insertNew(sql``),
      sql`SELECT EXISTS (SELECT 1 FROM customer_equipment WHERE id = ${neu}::uuid AND organization_id = ${org}::uuid AND customer_id = ${cust}::uuid) AS exists`,
    ]);
    if (!Array.isArray(rows)) return fail("stale");
    if (rows[1]!.length > 0) return { ok: true, equipmentId: neu, created: true, replaced: false };
    return rows[2]![0]?.exists === true ? { ok: true, equipmentId: neu, created: false, replaced: false } : fail("stale");
  }

  const old = input.replacesId;
  const oldVisible = sql`ce.id = ${old}::uuid AND ce.organization_id = ${org}::uuid AND ce.customer_id = ${cust}::uuid AND ${locationRuleSql("ce", "r")}`;
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`SELECT 1 FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      WHERE ${oldVisible} AND ce.fieldpulse_asset_id IS NULL AND r.customer_id = ${cust}::uuid AND (${onJob}) FOR NO KEY UPDATE OF ce`,
    insertNew(sql` AND EXISTS (SELECT 1 FROM customer_equipment ce WHERE ${oldVisible} AND ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL)`),
    sql`UPDATE customer_equipment ce SET retired_at = now(), replaced_by_equipment_id = ${neu}::uuid, updated_at = now()
      FROM service_requests r
      WHERE ${oldVisible} AND ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL AND ${reqOk}
        AND EXISTS (SELECT 1 FROM customer_equipment n WHERE n.id = ${neu}::uuid AND n.organization_id = ${org}::uuid AND n.xmin = pg_current_xact_id()::xid)
      RETURNING ce.id`,
    sql`SELECT ce.retired_at IS NOT NULL AS retired, ce.replaced_by_equipment_id, ce.fieldpulse_asset_id IS NOT NULL AS synced
      FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      WHERE ${oldVisible}`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[2]!.length > 0) return { ok: true, equipmentId: neu, created: true, replaced: true };
  return replaceOutcome(rows[4]![0], neu);
}
