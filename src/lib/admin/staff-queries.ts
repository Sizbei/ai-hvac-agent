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
 * BEFORE UPDATE trigger on `users` (migration 0008_last_admin_guard) that
 * raises `last_active_admin` if a write would remove the org's final active
 * admin. The application check here is kept as a fast, friendly path that
 * returns a clean 409 for the common (sequential) case; updateStaff also maps
 * the trigger's exception back to the same `last_admin` sentinel so the race
 * loser gets the same 409 rather than a 500.
 */
import { eq, ne, count, asc, inArray } from "drizzle-orm";
import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canManageRole, canAssignRole } from "@/lib/auth/authz";
import type { AdminRole } from "@/lib/auth/types";
import {
  ADMIN_TIER_ROLES,
  type StaffRecord,
  type StaffRole,
  type CreateStaffInput,
  type UpdateStaffInput,
} from "./types";

/** Admin-tier roles (super_admin + admin) as a mutable array for inArray(). */
const ADMIN_TIER = [...ADMIN_TIER_ROLES] as StaffRole[];

/** An admin-tier role holds an admin session and counts toward the org's
 * "keep one active admin" lockout guard. */
function isAdminTier(role: StaffRole): boolean {
  return role === "super_admin" || role === "admin";
}

/** Project a (possibly wider) StaffRole onto the AdminRole used by the authz
 * policy helpers. Only `super_admin` is privileged; every other tier (admin or
 * the never-a-session technician) is treated as a normal `admin` for the
 * policy, which confines it to managing technicians. This keeps the single
 * source of truth in authz.ts while accepting the wider StaffRole at the call
 * sites here. */
function toActorRole(role: StaffRole): AdminRole {
  return role === "super_admin" ? "super_admin" : "admin";
}

export const BCRYPT_COST = 12;

/** True when an error is the last-active-admin trigger violation (migration
 * 0008). We match on the marker token in the raised message rather than a
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

/** True when an error is the per-org unique-email violation (index
 * users_org_email_unique, migration 0029). We match on the index name in the
 * message so it survives neon-http error wrapping (Postgres SQLSTATE 23505). */
function isUniqueEmailViolation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes("users_org_email_unique");
}

function toStaffRecord(row: {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  isActive: boolean;
  createdAt: Date;
}): StaffRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

const STAFF_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
} as const;

/** Normalize an email for storage and collision checks: trimmed + lowercased.
 * Email comparison is case-insensitive, so we canonicalize before persisting so
 * the per-org uniqueness check can't be bypassed by changing case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function listStaff(
  organizationId: string,
): Promise<readonly StaffRecord[]> {
  const rows = await db
    .select(STAFF_COLUMNS)
    .from(users)
    .where(withTenant(users, organizationId))
    .orderBy(asc(users.role), asc(users.name));

  return rows.map(toStaffRecord);
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
  | { ok: false; reason: "email_conflict" | "forbidden" };

export async function createStaff(
  organizationId: string,
  input: CreateStaffInput,
  /** Role of the admin creating the user. Only a super_admin may create an
   * admin-tier user; a normal admin may only create technicians. Defaults to
   * "super_admin" for internal/seed callers — route handlers MUST pass the
   * real session role. */
  actorRole: StaffRole = "super_admin",
): Promise<CreateStaffResult> {
  // Privilege-escalation guard (policy in authz.ts): only a super_admin may
  // assign an admin-tier role; a normal admin may only ever mint a technician.
  if (!canAssignRole(toActorRole(actorRole), input.role)) {
    return { ok: false, reason: "forbidden" };
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

export type UpdateStaffResult =
  | { ok: true; staff: StaffRecord }
  | {
      ok: false;
      reason: "not_found" | "last_admin" | "no_changes" | "forbidden";
    };

export async function updateStaff(
  organizationId: string,
  userId: string,
  input: UpdateStaffInput,
  /** Role of the admin performing the update. Only a super_admin may manage an
   * admin-tier target or assign an admin-tier role; a normal admin is confined
   * to technicians. Defaults to "super_admin" only for internal/seed callers
   * that have already authorized themselves — route handlers MUST pass the real
   * session role. */
  actorRole: StaffRole = "super_admin",
): Promise<UpdateStaffResult> {
  const hasChange =
    input.name !== undefined ||
    input.role !== undefined ||
    input.isActive !== undefined;
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
  // admin or minting a new admin.
  const actor = toActorRole(actorRole);
  const cannotManageTarget = !canManageRole(actor, current.role);
  const cannotAssignRole =
    input.role !== undefined && !canAssignRole(actor, input.role);
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

  let updated;
  try {
    [updated] = await db
      .update(users)
      .set(updates)
      .where(withTenant(users, organizationId, eq(users.id, userId)))
      .returning(STAFF_COLUMNS);
  } catch (error: unknown) {
    // The DB trigger (migration 0008) is the authoritative last-admin guard;
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
  | { ok: false; reason: "not_found" | "forbidden" };

/** Reset a staff member's password to a new value. The plaintext password is
 * NEVER logged or returned — only the hash is persisted.
 *
 * SECURITY: only a super_admin may reset an admin-tier user's password. Without
 * this guard a normal admin could plant a password on a Google-only super_admin
 * (passwordHash NULL → set) and then authenticate as that super_admin via the
 * password-login route — a privilege-escalation path. We therefore load the
 * target's role first and refuse the reset unless the actor is a super_admin or
 * the target is a technician. */
export async function resetStaffPassword(
  organizationId: string,
  userId: string,
  newPassword: string,
  /** Role of the admin performing the reset. Defaults to "super_admin" for
   * internal callers; route handlers MUST pass the real session role. */
  actorRole: StaffRole = "super_admin",
): Promise<ResetPasswordResult> {
  // Load the target's role (org-scoped) so we can authorize against it.
  const [current] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, userId)))
    .limit(1);

  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  // Policy in authz.ts: managing an admin-tier target's credentials requires
  // super_admin. Without this a normal admin could plant a password on a
  // Google-only super_admin and then log in as them.
  if (!canManageRole(toActorRole(actorRole), current.role)) {
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
