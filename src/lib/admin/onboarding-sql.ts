import { sql, type SQL } from "drizzle-orm";
import type { StepId } from "./onboarding-state";
import { VISIBLE_ONLY, visibleRowsSql } from "./visibility";

/**
 * Pure SQL builders for the setup guide. Every subquery carries its own
 * organization_id predicate (nested ones included).
 */

/** OLD: the stored state as an object (a JSON null would break `||`). */
const OLD = sql`CASE WHEN jsonb_typeof(organization_settings.onboarding_state) = 'object' THEN organization_settings.onboarding_state ELSE '{}'::jsonb END`;

/**
 * One FROM-less SELECT of scalar subqueries, one column per Signals field.
 * The request signals (any, booked with a technician, completed) count visible
 * requests only, whoever is looking (plan ruling 2): hidden imported history
 * must neither tick "Book your first request" nor trigger grandfathering.
 * Technician, pricebook, widget, phone and integration signals describe real
 * configuration and are not filtered.
 */
export function onboardingSelectSql(organizationId: string): SQL {
  const o = organizationId;
  return sql`SELECT
  (SELECT company_name FROM organization_settings WHERE organization_id = ${o}) AS company_name,
  COALESCE((SELECT business_info->>'phone' <> '' FROM organization_settings WHERE organization_id = ${o}), false) AS phone,
  COALESCE((SELECT business_info->>'businessHours' <> '' FROM organization_settings WHERE organization_id = ${o}), false) AS business_hours,
  COALESCE((SELECT logo_url IS NOT NULL FROM organization_settings WHERE organization_id = ${o}), false) AS logo_url,
  EXISTS (SELECT 1 FROM users WHERE organization_id = ${o} AND role = 'technician' AND is_active AND (password_hash IS NOT NULL OR google_id IS NOT NULL)) AS technician_ready,
  (SELECT count(*) FROM users WHERE organization_id = ${o} AND role = 'technician' AND is_active AND password_hash IS NULL AND google_id IS NULL AND fieldpulse_user_id IS NOT NULL)::int AS fp_passwordless,
  (SELECT count(*) FROM users WHERE organization_id = ${o} AND role = 'technician' AND is_active AND password_hash IS NULL AND google_id IS NULL)::int AS tech_passwordless,
  EXISTS (SELECT 1 FROM staff_invites WHERE organization_id = ${o} AND role = 'technician' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now()) AS pending_invite,
  EXISTS (SELECT 1 FROM pricebook_items WHERE organization_id = ${o} AND active) AS pricebook,
  EXISTS (SELECT 1 FROM service_requests WHERE organization_id = ${o} AND ${visibleRowsSql("service_requests", VISIBLE_ONLY)}) AS any_request,
  EXISTS (SELECT 1 FROM appointments a JOIN service_requests r ON r.id = a.service_request_id AND r.organization_id = ${o} AND ${visibleRowsSql("r", VISIBLE_ONLY)} WHERE a.organization_id = ${o} AND a.cancelled_at IS NULL AND (a.starts_at IS NOT NULL OR a.scheduled_date IS NOT NULL) AND (
    EXISTS (SELECT 1 FROM appointment_assignments aa JOIN users u ON u.id = aa.technician_id WHERE aa.organization_id = ${o} AND aa.appointment_id = a.id AND aa.status <> 'cancelled'::request_status AND u.organization_id = ${o} AND u.role = 'technician')
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = r.assigned_to AND u.organization_id = ${o} AND u.role = 'technician')
  )) AS booked_assigned,
  (EXISTS (SELECT 1 FROM technician_time_entries WHERE organization_id = ${o})
    OR EXISTS (SELECT 1 FROM technician_locations WHERE organization_id = ${o})
    OR EXISTS (SELECT 1 FROM users WHERE organization_id = ${o} AND google_id IS NOT NULL AND role = 'technician' AND is_active)) AS tech_signed_in_evidence,
  EXISTS (SELECT 1 FROM widget_keys WHERE organization_id = ${o} AND key_type = 'publishable' AND is_active AND revoked_at IS NULL) AS widget_key,
  COALESCE((SELECT CASE WHEN jsonb_typeof(allowed_origins) = 'array' THEN jsonb_array_length(allowed_origins) > 0 ELSE false END FROM organization_settings WHERE organization_id = ${o}), false) AS allowed_origins,
  (EXISTS (SELECT 1 FROM fieldpulse_connections WHERE organization_id = ${o} AND connected = true)
    OR EXISTS (SELECT 1 FROM housecall_pro_connections WHERE organization_id = ${o} AND connected = true)
    OR EXISTS (SELECT 1 FROM google_calendar_connections WHERE organization_id = ${o} AND connected = true)) AS integration_connected,
  EXISTS (SELECT 1 FROM service_requests WHERE organization_id = ${o} AND status = 'completed'::request_status AND ${visibleRowsSql("service_requests", VISIBLE_ONLY)}) AS completed_request,
  (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM organizations WHERE id = ${o}) AS org_created_at,
  (SELECT onboarding_state FROM organization_settings WHERE organization_id = ${o}) AS onboarding_state`;
}

type Top = { firstSeenAt?: string; dismissedAt?: string; completedSeenAt?: string };

/** Drop undefined values so the JSON and the `?&` key arrays always agree. */
function definedOnly<T extends object>(obj: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

/**
 * First-completion stamps. `newStamps` = only ids not yet stamped; `top` =
 * `firstSeenAt` (first GET) plus grandfathering keys. Old values win
 * everywhere (write-once).
 */
export function stampStatementSql(p: {
  organizationId: string;
  newStamps: Partial<Record<StepId, string>>;
  top: Top;
}): SQL {
  const topObj = definedOnly(p.top);
  const newObj = definedOnly(p.newStamps);
  const top = JSON.stringify(topObj);
  const created = JSON.stringify(newObj);
  const keys = sql.param(Object.keys(newObj));
  const topKeys = sql.param(Object.keys(topObj));
  return sql`INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES (${p.organizationId}, ${top}::jsonb || jsonb_build_object('firstCompleted', ${created}::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  ${top}::jsonb || ${OLD}, '{firstCompleted}',
  ${created}::jsonb || CASE WHEN jsonb_typeof((${OLD})->'firstCompleted') = 'object' THEN (${OLD})->'firstCompleted' ELSE '{}'::jsonb END, true)
WHERE NOT (COALESCE((${OLD})->'firstCompleted', '{}'::jsonb) ?& ${keys}::text[])
   OR NOT ((${OLD}) ?& ${topKeys}::text[])
RETURNING onboarding_state`;
}

/**
 * Flag writes (PATCH keys + the technician sign-in hook). `guardTechSignedIn`
 * makes the technician hook write-once.
 */
export function flagsStatementSql(p: {
  organizationId: string;
  flags: { embedCopied?: true; techSignedInAt?: string };
  top: Top;
  guardTechSignedIn?: boolean;
}): SQL {
  const top = JSON.stringify(definedOnly(p.top));
  const flags = JSON.stringify(definedOnly(p.flags));
  const guard = p.guardTechSignedIn
    ? sql`WHERE (${OLD}) #> '{flags,techSignedInAt}' IS NULL`
    : sql``;
  return sql`INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES (${p.organizationId}, ${top}::jsonb || jsonb_build_object('flags', ${flags}::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  ${top}::jsonb || ${OLD}, '{flags}',
  ${flags}::jsonb || CASE WHEN jsonb_typeof((${OLD})->'flags') = 'object' THEN (${OLD})->'flags' ELSE '{}'::jsonb END, true)
${guard}
RETURNING onboarding_state`;
}

/**
 * "Show setup guide on home page": removes `dismissedAt` (and the legacy
 * `dismissed: true`, which the parser folds into dismissedAt) so the home card and
 * the Operations placement come back. The only write that removes a top key;
 * a later dismiss sets it again (absent key → new value wins).
 */
export function clearDismissalSql(organizationId: string): SQL {
  return sql`UPDATE organization_settings SET onboarding_state = onboarding_state - 'dismissedAt' - 'dismissed'
WHERE organization_id = ${organizationId}
RETURNING onboarding_state`;
}
