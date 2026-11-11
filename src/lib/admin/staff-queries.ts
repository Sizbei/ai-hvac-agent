/**
 * Staff (admin + technician) user-management queries.
 *
 * Where queries.ts exposes technician-only helpers, THIS module manages every
 * user in the org — listing both roles, inviting admins, changing roles,
 * (de)activating, and resetting passwords.
 *
 * Two org-level safety invariants are enforced here, NOT in the route, so they
 * hold no matter who calls them:
 *
 *   1. Email is unique per organization. Create/role-change pre-checks for a
 *      collision and returns an "email_conflict" sentinel (route → 409).
 *   2. An organization can never be left with zero ACTIVE admins. Demoting or
 *      deactivating the last active admin returns a "last_admin" sentinel
 *      (route → 409). Without this an org could lock itself out of its own
 *      admin panel permanently.
 *
 * Functions return discriminated sentinels instead of throwing so the route
 * can map each to a precise HTTP status. neon-http has no transactions, so the
 * application-level last-admin check is a read-then-write and is NOT race-proof
 * on its own: two admins demoting each OTHER concurrently could both pass it
 * and leave the org with zero active admins. The authoritative guard is a
 * BEFORE UPDATE trigger on `users` (migration 0044_last_admin_guard) that
 * raises `last_active_admin` if a write would remove the org's final active
 * admin. The application check here is kept as a fast, friendly path that
 * returns a clean 409 for the common (sequential) case; updateStaff also maps
 * the trigger's exception back to the same `last_admin` sentinel so the race
 * loser gets the same 409 rather than a 500.
 */
import { eq, ne, count, asc, inArray, isNull } from "drizzle-orm";
import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import {
  canManageRole,
  canAssignRole,
  assertMayMutateUser,
  type MutationActor,
} from "@/lib/auth/authz";
import {
  ADMIN_TIER_ROLES,
  type StaffRecord,
  type StaffRole,
  type CreateStaffInput,
  type UpdateStaffInput,
} from "./types";
import { withoutRetiredDemoUsers } from "./retired-demo-users";
import type { Visibility } from "./visibility";

/** Admin-tier roles (super_admin + admin) as a mutable array for inArray(). */
const ADMIN_TIER = [...ADMIN_TIER_ROLES] as StaffRole[];

/** An admin-tier role holds an admin session and counts toward the org's
 * "keep one active admin" lockout guard. */
function isAdminTier(role: StaffRole): boolean {
  return role === "super_admin" || role === "admin";
}

export const BCRYPT_COST = 12;

/** True when an error is the last-active-admin trigger violation (migration
 * 0044). We match on the marker token in the raised message rather than a
 * driver-specific error shape so it survives error wrapping by neon-http. */
function isLastAdminViolation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes("last_active_admin");
}

/** True when an error is a unique-email violation on the users table — either
 * the per-org index (users_org_email_unique, migration 0029) or the GLOBAL
 * cross-org index (users_email_global_unique). A cross-org invite for an email
 * that already exists in another org now trips the global index; both map to the
 * same friendly email_conflict sentinel (not a 500). We match on the index name
 * in the message so it survives neon-http error wrapping (Postgres SQLSTATE
 * 23505). */
function isUniqueEmailViolation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    message.includes("users_org_email_unique") ||
    message.includes("users_email_global_unique")
  );
}

function toStaffRecord(row: {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  isActive: boolean;
  createdAt: Date;
  laborRateCents: number | null;
  fieldpulseUserId: string | null;
  passwordHash: string | null;
}): StaffRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    laborRateCents: row.laborRateCents,
    isFpSynced: row.fieldpulseUserId != null,
    hasLogin: row.passwordHash != null,
  };
}

const STAFF_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
  laborRateCents: users.laborRateCents,
  fieldpulseUserId: users.fieldpulseUserId,
  passwordHash: users.passwordHash,
} as const;

/** Normalize an email for storage and collision checks: trimmed + lowercased.
 * Email comparison is case-insensitive, so we canonicalize before persisting so
 * the per-org uniqueness check can't be bypassed by changing case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function listStaff(
  organizationId: string,
  vis: Visibility,
): Promise<readonly StaffRecord[]> {
  const rows = await db
    .select(STAFF_COLUMNS)
    .from(users)
    .where(withTenant(users, organizationId))
    .orderBy(asc(users.role), asc(users.name));

  return withoutRetiredDemoUsers(rows, vis).map(toStaffRecord);
}

/** Count active admin-tier users (super_admin OR admin) in the org, optionally
 * excluding one user id (used to check "would this leave zero active admins").
 * A super_admin counts as an admin for the lockout guard — an org whose only
 * privileged user is a super_admin must not be demotable into lockout. */
async function countActiveAdmins(
  organizationId: string,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    inArray(users.role, ADMIN_TIER),
    eq(users.isActive, true),
  ];
  if (excludeUserId) {
    conditions.push(ne(users.id, excludeUserId));
  }

  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(withTenant(users, organizationId, ...conditions));

  // neon-http returns count() as a string.
  return Number(row?.value ?? 0);
}

export type CreateStaffResult =
  | { ok: true; staff: StaffRecord }
  | {
      ok: false;
      reason: "email_conflict" | "forbidden" | "platform_protected";
    };

export async function createStaff(
  organizationId: string,
  input: CreateStaffInput,
  /** Who is creating the user (the session, or an invite's inviter). Only a
   * super_admin may create an admin-tier user; a normal admin may only create
   * technicians; nobody but a platform admin may create a platform-admin email. */
  actor: MutationActor,
): Promise<CreateStaffResult> {
  // Privilege-escalation guard (policy in authz.ts): only a super_admin may
  // assign an admin-tier role; a normal admin may only ever mint a technician.
  if (!canAssignRole(actor.role, input.role)) {
    return { ok: false, reason: "forbidden" };
  }
  if (!assertMayMutateUser(actor, { newEmail: input.email }).ok) {
    return { ok: false, reason: "platform_protected" };
  }

  const email = normalizeEmail(input.email);

  // Per-org email uniqueness: reject before hashing/inserting.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.email, email)))
    .limit(1);

  if (existing) {
    return { ok: false, reason: "email_conflict" };
  }

  const passwordHash = await hash(input.password, BCRYPT_COST);

  let created;
  try {
    [created] = await db
      .insert(users)
      .values({
        organizationId,
        name: input.name,
        email,
        passwordHash,
        role: input.role,
        isActive: true,
      })
      .returning(STAFF_COLUMNS);
  } catch (error: unknown) {
    // The per-org unique email index (migration 0029) is the authoritative
    // guard behind the read-then-insert pre-check above, which races under
    // concurrency. If two creates for the same org+email interleave, the loser
    // hits the unique violation here — map it to the same friendly sentinel.
    if (isUniqueEmailViolation(error)) {
      return { ok: false, reason: "email_conflict" };
    }
    throw error;
  }

  if (!created) {
    throw new Error("Failed to create staff member");
  }

  return { ok: true, staff: toStaffRecord(created) };
}

/**
 * Whether one staff member is currently active (org-scoped). null when the
 * user isn't in this org. Used by the reactivation seat gate.
 */
export async function isStaffActive(
  organizationId: string,
  userId: string,
): Promise<boolean | null> {
  const [row] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, userId)))
    .limit(1);
  return row ? row.isActive : null;
}

export type UpdateStaffResult =
  | { ok: true; staff: StaffRecord }
  | {
      ok: false;
      reason:
        | "not_found"
        | "last_admin"
        | "no_changes"
        | "forbidden"
        | "platform_protected";
    };

export async function updateStaff(
  organizationId: string,
  userId: string,
  input: UpdateStaffInput,
  /** Who is performing the update. Only a super_admin may manage an admin-tier
   * target or assign an admin-tier role; a normal admin is confined to
   * technicians; only a platform admin may change a platform admin's row. */
  actor: MutationActor,
): Promise<UpdateStaffResult> {
  const hasChange =
    input.name !== undefined ||
    input.role !== undefined ||
    input.isActive !== undefined ||
    input.laborRateCents !== undefined;
  if (!hasChange) {
    return { ok: false, reason: "no_changes" };
  }

  // Load the current row (org-scoped) so we can reason about the last-admin
  // invariant against its real present state, not the caller's assumptions.
  const [current] = await db
    .select(STAFF_COLUMNS)
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, userId)))
    .limit(1);

  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  // Authorization (policy in authz.ts): only a super_admin may manage an
  // admin-tier user (admin or super_admin) OR promote anyone INTO an admin-tier
  // role. A normal admin can only touch technicians. This is the
  // privilege-escalation guard — it stops an admin from editing/demoting another
  // admin or minting a new admin. The platform operator's row is off limits to
  // everyone but a platform admin, whatever the change.
  const cannotManageTarget = !canManageRole(actor.role, current.role);
  const cannotAssignRole =
    input.role !== undefined && !canAssignRole(actor.role, input.role);
  if (!assertMayMutateUser(actor, { email: current.email }).ok) {
    return { ok: false, reason: "platform_protected" };
  }
  if (cannotManageTarget || cannotAssignRole) {
    return { ok: false, reason: "forbidden" };
  }

  // Does this patch remove admin access from a currently-active admin? That's
  // either an explicit demotion (role → technician) or a deactivation.
  const losesAdminAccess =
    isAdminTier(current.role) &&
    current.isActive &&
    ((input.role !== undefined && !isAdminTier(input.role)) ||
      input.isActive === false);

  if (losesAdminAccess) {
    // If no OTHER active admin remains, this would lock the org out.
    const otherActiveAdmins = await countActiveAdmins(organizationId, userId);
    if (otherActiveAdmins === 0) {
      return { ok: false, reason: "last_admin" };
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.role !== undefined) updates.role = input.role;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.laborRateCents !== undefined)
    updates.laborRateCents = input.laborRateCents;

  let updated;
  try {
    [updated] = await db
      .update(users)
      .set(updates)
      .where(withTenant(users, organizationId, eq(users.id, userId)))
      .returning(STAFF_COLUMNS);
  } catch (error: unknown) {
    // The DB trigger (migration 0044) is the authoritative last-admin guard;
    // if the app-level check above lost a race, the trigger raises here. Map it
    // back to the same sentinel so the caller gets a 409, not a 500.
    if (isLastAdminViolation(error)) {
      return { ok: false, reason: "last_admin" };
    }
    throw error;
  }

  if (!updated) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, staff: toStaffRecord(updated) };
}

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" | "platform_protected" };

/** Reset a staff member's password to a new value. The plaintext password is
 * NEVER logged or returned — only the hash is persisted.
 *
 * SECURITY: only a super_admin may reset an admin-tier user's password. Without
 * this guard a normal admin could plant a password on a Google-only super_admin
 * (passwordHash NULL → set) and then authenticate as that super_admin via the
 * password-login route — a privilege-escalation path. We therefore load the
 * target's role first and refuse the reset unless the actor is a super_admin or
 * the target is a technician. A platform admin's password can only be reset by
 * a platform admin. */
export async function resetStaffPassword(
  organizationId: string,
  userId: string,
  newPassword: string,
  /** Who is performing the reset (the session). */
  actor: MutationActor,
): Promise<ResetPasswordResult> {
  // Load the target's role + email (org-scoped) so we can authorize against it.
  const [current] = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, userId)))
    .limit(1);

  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  // Policy in authz.ts: managing an admin-tier target's credentials requires
  // super_admin. Without this a normal admin could plant a password on a
  // Google-only super_admin and then log in as them.
  if (!assertMayMutateUser(actor, { email: current.email }).ok) {
    return { ok: false, reason: "platform_protected" };
  }
  if (!canManageRole(actor.role, current.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const passwordHash = await hash(newPassword, BCRYPT_COST);

  const [updated] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(withTenant(users, organizationId, eq(users.id, userId)))
    .returning({ id: users.id });

  if (!updated) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true };
}

export type ClaimPasswordlessStaffResult =
  | { ok: true; staff: { id: string; email: string; name: string } }
  | { ok: false; reason: "not_claimable" | "forbidden" | "platform_protected" };

/**
 * Set a first password on an EXISTING password-less user — the invite-accept
 * path for users provisioned without credentials (FieldPulse-synced
 * technicians, Google-only staff). Authorization comes from the invite token
 * (created by an admin whose authority was checked at create time), so the
 * eligibility rules ARE the security boundary:
 *  - the user must be active,
 *  - must have NO password (a live credential can never be overwritten), and
 *  - must hold exactly the invite's role (a technician invite can't plant a
 *    password on an admin).
 * The UPDATE re-asserts password_hash IS NULL so two concurrent accepts can't
 * both claim; the loser reports not_claimable.
 *
 * `actor` is the invite's inviter (plan ruling 6). It must be allowed to manage
 * the user's role ("forbidden"), and only a platform admin may claim a platform
 * admin's row ("platform_protected").
 */
export async function claimPasswordlessStaff(
  organizationId: string,
  input: { email: string; role: StaffRole; password: string },
  actor: MutationActor,
): Promise<ClaimPasswordlessStaffResult> {
  const email = normalizeEmail(input.email);
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.email, email)))
    .limit(1);

  if (!user) {
    return { ok: false, reason: "not_claimable" };
  }
  if (!assertMayMutateUser(actor, { email: user.email }).ok) {
    return { ok: false, reason: "platform_protected" };
  }
  if (!canManageRole(actor.role, user.role)) {
    return { ok: false, reason: "forbidden" };
  }
  if (
    !user.isActive ||
    user.passwordHash !== null ||
    user.role !== input.role
  ) {
    return { ok: false, reason: "not_claimable" };
  }

  const passwordHash = await hash(input.password, BCRYPT_COST);
  const [updated] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(
      withTenant(
        users,
        organizationId,
        eq(users.id, user.id),
        isNull(users.passwordHash),
      ),
    )
    .returning({ id: users.id });

  if (!updated) {
    return { ok: false, reason: "not_claimable" };
  }
  return {
    ok: true,
    staff: { id: user.id, email: user.email, name: user.name },
  };
}
