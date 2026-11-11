import "server-only";

/**
 * "View as" targets and the start/exit audit trail (spec P7).
 * A target is an ACTIVE user of the platform admin's own session org.
 */
import { asc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformAuditLog, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { AdminSessionPayload } from "@/lib/auth/types";

export interface PreviewTarget {
  readonly userId: string;
  readonly name: string;
  readonly role: "super_admin" | "admin" | "technician";
}

/** A resolved target: also its email, for the sidebar chip (never sent by the list route). */
export interface ResolvedPreviewTarget extends PreviewTarget {
  readonly email: string;
}

const targetColumns = { userId: users.id, name: users.name, role: users.role };

/** Active users of `orgId`, minus `excludeUserId` (the platform admin). */
export async function listPreviewTargets(
  orgId: string,
  excludeUserId: string,
): Promise<PreviewTarget[]> {
  return db
    .select(targetColumns)
    .from(users)
    .where(withTenant(users, orgId, eq(users.isActive, true), ne(users.id, excludeUserId)))
    .orderBy(asc(users.role), asc(users.name));
}

/** The target when `userId` is an active user of `orgId`; otherwise null. */
export async function findPreviewTarget(
  orgId: string,
  userId: string,
): Promise<ResolvedPreviewTarget | null> {
  const [row] = await db
    .select({ ...targetColumns, email: users.email })
    .from(users)
    .where(withTenant(users, orgId, eq(users.id, userId), eq(users.isActive, true)))
    .limit(1);
  return row ?? null;
}

/** platform_audit_log row for a preview start/exit: ids only. */
export async function recordPreviewAudit(p: {
  action: "preview_start" | "preview_exit";
  session: AdminSessionPayload;
  targetUserId: string;
}): Promise<void> {
  await db.insert(platformAuditLog).values({
    action: p.action,
    actorUserId: p.session.userId,
    actorEmail: p.session.email,
    targetOrgId: p.session.organizationId,
    details: { targetUserId: p.targetUserId },
  });
}
