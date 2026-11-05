import { sql, type SQL } from "drizzle-orm";
import type { StepId } from "./guide-state";
import { OPEN_ASSIGNMENT_STATUSES } from "./ownership";

/** Pure SQL builders for the technician getting-started guide (spec §3/§4). */

const OLD = sql`CASE WHEN jsonb_typeof(users.field_guide_state) = 'object' THEN users.field_guide_state ELSE '{}'::jsonb END`;
const FC = sql`CASE WHEN jsonb_typeof((${OLD})->'firstCompleted') = 'object' THEN (${OLD})->'firstCompleted' ELSE '{}'::jsonb END`;
const OPEN_IN = sql.raw(`(${OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'::request_status`).join(", ")})`);

/** LEAD_ON_LIVE(r) / ASSIGNED_ON_LIVE(r): this technician on a live visit of request alias r. */
function onLive(o: string, u: string, lead: boolean): SQL {
  const leadPred = lead ? sql` AND a.is_lead` : sql``;
  return sql`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = r.id AND a.organization_id = ${o} AND p.organization_id = ${o} AND a.technician_id = ${u}${leadPred} AND a.status <> 'cancelled'::request_status AND p.cancelled_at IS NULL)`;
}

export function guideSelectSql(organizationId: string, userId: string): SQL {
  const o = organizationId;
  const u = userId;
  return sql`SELECT
  EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = ${o} AND technician_id = ${u} AND (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL)) AS start_job,
  EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = ${o} AND technician_id = ${u} AND completed_at IS NOT NULL AND started_at IS NOT NULL) AS finish_job,
  EXISTS (SELECT 1 FROM technician_time_entries WHERE organization_id = ${o} AND technician_id = ${u} AND kind = 'general') AS clock_in,
  COALESCE((SELECT location_sharing_enabled FROM users WHERE id = ${u} AND organization_id = ${o}), false) AS share_location,
  EXISTS (SELECT 1 FROM job_materials WHERE organization_id = ${o} AND created_by = ${u}) AS add_material,
  (EXISTS (SELECT 1 FROM request_notes WHERE organization_id = ${o} AND author_id = ${u})
    OR EXISTS (SELECT 1 FROM attachments t JOIN service_requests r ON r.id = t.service_request_id WHERE t.organization_id = ${o} AND r.organization_id = ${o} AND t.session_id IS NULL AND t.message_id IS NULL AND position('_admin_' in t.storage_key) = 0 AND ${onLive(o, u, false)})) AS note_or_photo,
  EXISTS (SELECT 1 FROM service_requests r WHERE r.organization_id = ${o} AND r.signed_at IS NOT NULL AND ${onLive(o, u, true)}) AS capture_signature,
  EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = ${o} AND r.organization_id = ${o} AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL AND i.state IN ('open'::invoice_state, 'paid'::invoice_state, 'refunded'::invoice_state) AND ${onLive(o, u, true)}) AS build_invoice,
  (EXISTS (SELECT 1 FROM payments WHERE organization_id = ${o} AND recorded_by = ${u} AND status = 'succeeded'::payment_status)
    OR EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = ${o} AND r.organization_id = ${o} AND i.pay_link_sent_at IS NOT NULL AND ${onLive(o, u, true)})) AS collect_payment,
  EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id JOIN service_requests r ON r.id = p.service_request_id WHERE a.organization_id = ${o} AND p.organization_id = ${o} AND r.organization_id = ${o} AND a.technician_id = ${u} AND a.status IN ${OPEN_IN} AND p.cancelled_at IS NULL AND r.status NOT IN ('completed', 'cancelled')) AS has_open_job,
  (SELECT field_guide_state FROM users WHERE id = ${u} AND organization_id = ${o}) AS field_guide_state`;
}

function definedOnly<T extends object>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** First-completion stamps; old values win; no-op when every key is already present. */
export function guideStampSql(p: { organizationId: string; userId: string; newStamps: Partial<Record<StepId, string>> }): SQL {
  const newObj = definedOnly(p.newStamps);
  const created = JSON.stringify(newObj);
  const keys = sql.param(Object.keys(newObj));
  return sql`UPDATE users SET field_guide_state = jsonb_set(${OLD}, '{firstCompleted}', ${created}::jsonb || ${FC}, true)
WHERE id = ${p.userId} AND organization_id = ${p.organizationId} AND role = 'technician'
  AND NOT (${FC} ?& ${keys}::text[])`;
}

/** Hide the card (write-once: an existing hiddenAt wins). Always returns the row for a live technician. */
export function guideHideSql(p: { organizationId: string; userId: string; hiddenAt: string }): SQL {
  return sql`UPDATE users SET field_guide_state = jsonb_build_object('hiddenAt', ${p.hiddenAt}::text) || ${OLD}
WHERE id = ${p.userId} AND organization_id = ${p.organizationId} AND role = 'technician'
RETURNING field_guide_state`;
}
