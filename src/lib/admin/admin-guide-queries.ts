import "server-only";

import { db } from "@/lib/db";
import { platformAdminEmails } from "@/lib/auth/authz";
import type { ViewerContext } from "@/lib/auth/viewer";
import { parseFeatures } from "@/lib/tenancy/feature-flags";
import { adminGuidePatchSql, adminGuideSelectSql } from "./admin-guide-sql";
import {
  buildGuidePayload,
  contactOrFallback,
  guidePatchWrites,
  parseAdminGuideState,
  type AdminGuidePayload,
  type GuidePatch,
} from "./admin-guide-state";

type Row = Record<string, unknown>;

/**
 * Whose guide the viewer sees: the preview target while previewing, else the
 * session user. A stale preview has no subject, and so does `readOnly` with no
 * resolved preview (a preview cookie the viewer could not resolve). Never from
 * client input.
 */
function subjectOf(viewer: ViewerContext, readOnly: boolean): { userId: string | null; role: string } {
  const { preview, session } = viewer;
  if (preview?.status === "active") return { userId: preview.targetUserId, role: preview.targetRole };
  if (preview?.status === "stale" || readOnly) return { userId: null, role: session.role };
  return { userId: session.userId, role: session.role };
}

/**
 * The `guide` payload (spec D1): one SELECT, never writes. Throws on a DB
 * error; the onboarding route degrades that to `guide: null`.
 */
export async function readAdminGuide(
  viewer: ViewerContext,
  { readOnly }: { readOnly: boolean },
): Promise<AdminGuidePayload> {
  const subject = subjectOf(viewer, readOnly);
  const res = await db.execute(
    adminGuideSelectSql({
      organizationId: viewer.session.organizationId,
      userId: subject.userId,
      contactEmails: platformAdminEmails(),
    }),
  );
  const row = (res.rows[0] ?? {}) as Row;
  return buildGuidePayload({
    state: subject.userId ? parseAdminGuideState(row.state) : null,
    role: subject.role,
    readOnly,
    // Same parse as getFeatures(org), read in this SELECT; a failed read is guide: null.
    payLinks: parseFeatures(row.feature_flags).payLinks,
    hasFieldPulse: row.has_field_pulse === true,
    historyHidden: !viewer.showHidden,
    contactName: typeof row.contact_name === "string" ? row.contact_name : null,
  });
}

/**
 * The platform owner's display name in `organizationId` (or the generic
 * fallback), for "… handled by {name}" copy. Never an email. Same SELECT as the
 * guide read, with no subject user. Throws on a DB error.
 */
export async function readHistoryContact(organizationId: string): Promise<string> {
  const res = await db.execute(
    adminGuideSelectSql({ organizationId, userId: null, contactEmails: platformAdminEmails() }),
  );
  const row = (res.rows[0] ?? {}) as Row;
  return contactOrFallback(typeof row.contact_name === "string" ? row.contact_name : null);
}

/** PATCH: one UPDATE on the user's own row, every time (no no-op skip). */
export async function patchAdminGuide(
  organizationId: string,
  userId: string,
  patch: GuidePatch,
  now: Date = new Date(),
): Promise<void> {
  const writes = guidePatchWrites(patch, now.toISOString());
  await db.execute(adminGuidePatchSql({ organizationId, userId, ...writes }));
}
