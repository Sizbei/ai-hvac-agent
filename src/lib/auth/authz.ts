import "server-only";

import type { AdminSessionPayload, AdminRole } from "./types";

/**
 * Role helpers for admin authorization.
 *
 * The role hierarchy (within an organization — there is NO cross-org access):
 *   super_admin > admin > technician
 *
 * `super_admin` is the top tier: it can do everything an admin can, PLUS manage
 * other admins/super_admins, and it is protected — only another super_admin may
 * demote, deactivate, or delete a super_admin. `technician` never holds an admin
 * session (verifyToken rejects it), so it does not appear in AdminRole.
 */

/** True when the session belongs to a super_admin. */
export function isSuperAdmin(
  session: Pick<AdminSessionPayload, "role">,
): boolean {
  return session.role === "super_admin";
}

/**
 * Whether `session` belongs to a PLATFORM admin — the cross-org operator who may
 * provision new tenants. This is deliberately SEPARATE from `super_admin`: a
 * super_admin is the top role WITHIN one org and must NOT be able to create
 * other orgs. Platform-admin authority comes only from an env allowlist
 * (PLATFORM_ADMIN_EMAILS, comma-separated), checked by normalized email — so it
 * cannot be granted by any in-app role change.
 *
 * Returns false when the env var is unset/empty (closed by default).
 */
export function isPlatformAdmin(
  session: Pick<AdminSessionPayload, "email" | "organizationId">,
): boolean {
  const allow = process.env.PLATFORM_ADMIN_EMAILS;
  const platformOrgId = process.env.PLATFORM_ORG_ID?.trim();
  // Fail CLOSED unless BOTH are configured. Email alone was tenant-forgeable: a
  // tenant super_admin can mint a user with an allowlisted email in THEIR org
  // (the global-unique index only blocks emails that already have a row), log
  // in, and self-escalate to all-tenant platform access (list/export ANY org).
  // Binding to the designated platform org closes that — an attacker can't
  // place their user in an org they don't control.
  if (!allow || !platformOrgId) return false;
  if (session.organizationId !== platformOrgId) return false;

  const sessionEmail = session.email.trim().toLowerCase();
  if (!sessionEmail) return false;

  return allow
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .includes(sessionEmail);
}

/**
 * Whether `actorRole` is allowed to manage a user whose role is `targetRole`
 * (create, promote/demote, activate/deactivate, delete, reset password).
 *
 * Rule: managing an admin-tier user (admin or super_admin) requires super_admin.
 * A normal admin may only manage technicians. A super_admin may manage anyone.
 * (Self-action guards — e.g. you can't demote yourself — are enforced
 * separately at the call site, since they depend on identity, not just role.)
 */
export function canManageRole(
  actorRole: AdminRole,
  targetRole: "super_admin" | "admin" | "technician",
): boolean {
  if (actorRole === "super_admin") return true;
  // actorRole === "admin": may only manage technicians.
  return targetRole === "technician";
}

/**
 * Whether `actorRole` may assign `desiredRole` to a user. Only a super_admin may
 * grant or set an admin-tier role; an admin can only ever set "technician".
 * Prevents privilege escalation (an admin minting another admin or a super_admin).
 */
export function canAssignRole(
  actorRole: AdminRole,
  desiredRole: "super_admin" | "admin" | "technician",
): boolean {
  // Defense-in-depth: this function never grants super_admin, regardless of the
  // caller's static types. super_admin is reserved for the provisioned-org owner
  // promotion (see acceptInvite) and direct super_admin management
  // (canManageRole) — it must NEVER be assignable through the invite/assign path.
  if (desiredRole === "super_admin") return false;
  if (actorRole === "super_admin") return true;
  return desiredRole === "technician";
}
