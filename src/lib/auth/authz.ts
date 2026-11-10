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

/** The public portfolio demo login. Outbound sending (SMS reminders, inbox
 * replies) is disabled for this account so a visitor can't message real people. */
const DEMO_ACCOUNT_EMAIL = "admin@demo-hvac.com";

/** True when the session belongs to the public portfolio demo account. */
export function isDemoAccount(
  session: Pick<AdminSessionPayload, "email">,
): boolean {
  return session.email.trim().toLowerCase() === DEMO_ACCOUNT_EMAIL;
}

/** True when the session belongs to a super_admin. */
export function isSuperAdmin(
  session: Pick<AdminSessionPayload, "role">,
): boolean {
  return session.role === "super_admin";
}

/**
 * Whether `email` is on the platform-admin allowlist (PLATFORM_ADMIN_EMAILS,
 * comma-separated, compared trimmed + lowercased). This says nothing about
 * WHO is acting — it identifies the rows that belong to the platform operator,
 * so they can be protected from org admins. Use `isPlatformAdmin` to decide
 * whether an actor holds platform authority.
 *
 * Returns false when the env var is unset/empty or the email is blank.
 */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  const allow = process.env.PLATFORM_ADMIN_EMAILS;
  if (!allow || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allow
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .includes(normalized);
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
  const platformOrgId = process.env.PLATFORM_ORG_ID?.trim();
  // Fail CLOSED unless BOTH are configured. Email alone was tenant-forgeable: a
  // tenant super_admin can mint a user with an allowlisted email in THEIR org
  // (the global-unique index only blocks emails that already have a row), log
  // in, and self-escalate to all-tenant platform access (list/export ANY org).
  // Binding to the designated platform org closes that — an attacker can't
  // place their user in an org they don't control.
  if (!platformOrgId) return false;
  if (session.organizationId !== platformOrgId) return false;
  return isPlatformAdminEmail(session.email);
}

/**
 * Who is changing a user row. `AdminSessionPayload` satisfies it; the invite
 * accept flow builds one from the inviter's CURRENT users row.
 */
export interface MutationActor {
  readonly userId: string;
  readonly email: string;
  readonly role: AdminRole;
  readonly organizationId: string;
}

/**
 * Whether `actor` may change a user row (create, edit, role, active flag,
 * password, email, invite/claim). The platform operator's rows are protected:
 * only a platform admin may touch a row whose CURRENT email (`target.email`) or
 * requested email (`target.newEmail`) is on the platform allowlist. Without
 * this, an org super_admin sharing the platform org could reset the operator's
 * password, re-email the account, or claim it through an invite.
 *
 * Role rules (canManageRole / canAssignRole) are separate and still apply.
 */
export function assertMayMutateUser(
  actor: MutationActor,
  target: { readonly email?: string | null; readonly newEmail?: string | null },
): { ok: true } | { ok: false; reason: "platform_protected" } {
  const touchesPlatformRow =
    isPlatformAdminEmail(target.email) || isPlatformAdminEmail(target.newEmail);
  if (touchesPlatformRow && !isPlatformAdmin(actor)) {
    return { ok: false, reason: "platform_protected" };
  }
  return { ok: true };
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
