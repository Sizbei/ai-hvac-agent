import { sql, type SQL } from "drizzle-orm";
import type { LessonId, WriteOnceKey } from "./admin-guide-state";

/** Pure SQL builders for the per-user admin guide (onboarding spec D1). */

const OLD = sql`CASE WHEN jsonb_typeof(users.admin_guide_state) = 'object' THEN users.admin_guide_state ELSE '{}'::jsonb END`;

/**
 * The guide read: separate from onboardingSelectSql, never writes. `userId` is
 * null for a stale preview (no subject). `contactEmails` is the normalized
 * PLATFORM_ADMIN_EMAILS list; only the matching user's display name is read.
 */
export function adminGuideSelectSql(p: {
  organizationId: string;
  userId: string | null;
  contactEmails: readonly string[];
}): SQL {
  const o = p.organizationId;
  const state = p.userId
    ? sql`(SELECT admin_guide_state FROM users WHERE id = ${p.userId} AND organization_id = ${o})`
    : sql`NULL::jsonb`;
  const contact = p.contactEmails.length > 0
    ? sql`(SELECT name FROM users WHERE organization_id = ${o} AND is_active AND lower(trim(email)) = ANY(${sql.param([...p.contactEmails])}::text[]) ORDER BY created_at, id LIMIT 1)`
    : sql`NULL::text`;
  return sql`SELECT
  ${state} AS state,
  EXISTS (SELECT 1 FROM fieldpulse_connections WHERE organization_id = ${o} AND connected = true) AS has_field_pulse,
  (SELECT feature_flags FROM organizations WHERE id = ${o}) AS feature_flags,
  ${contact} AS contact_name`;
}

/**
 * One UPDATE on the session user's own active admin-tier row. Write-once keys
 * sit LEFT of the stored object (a stored value wins); `lastLesson` sits right
 * of it (always overwritten). A non-object stored value is treated as `{}`.
 */
export function adminGuidePatchSql(p: {
  organizationId: string;
  userId: string;
  writeOnce: Partial<Record<WriteOnceKey, string>>;
  lastLesson?: LessonId;
}): SQL {
  const writeOnce = JSON.stringify(p.writeOnce);
  const last = JSON.stringify(p.lastLesson ? { lastLesson: p.lastLesson } : {});
  return sql`UPDATE users SET admin_guide_state = ((${writeOnce}::jsonb || (${OLD})) || ${last}::jsonb)
WHERE id = ${p.userId} AND organization_id = ${p.organizationId} AND role IN ('admin', 'super_admin') AND is_active`;
}
