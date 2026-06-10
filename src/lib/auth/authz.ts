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
  if (actorRole === "super_admin") return true;
  return desiredRole === "technician";
}
