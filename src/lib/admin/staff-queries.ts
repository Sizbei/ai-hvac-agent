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
import { eq, ne, count, asc } from "drizzle-orm";
import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  StaffRecord,
  CreateStaffInput,
  UpdateStaffInput,
} from "./types";

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

function toStaffRecord(row: {
  id: string;
  name: string;
  email: string;
  role: "admin" | "technician";
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

/** Count active admins in the org, optionally excluding one user id (used to
 * check "would this leave zero active admins"). */
async function countActiveAdmins(
  organizationId: string,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    eq(users.role, "admin"),
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
  | { ok: false; reason: "email_conflict" };

export async function createStaff(
  organizationId: string,
  input: CreateStaffInput,
): Promise<CreateStaffResult> {
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

  const [created] = await db
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

  if (!created) {
    throw new Error("Failed to create staff member");
  }

  return { ok: true, staff: toStaffRecord(created) };
}

export type UpdateStaffResult =
  | { ok: true; staff: StaffRecord }
  | { ok: false; reason: "not_found" | "last_admin" | "no_changes" };

export async function updateStaff(
  organizationId: string,
  userId: string,
  input: UpdateStaffInput,
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

  // Does this patch remove admin access from a currently-active admin? That's
  // either an explicit demotion (role → technician) or a deactivation.
  const losesAdminAccess =
    current.role === "admin" &&
    current.isActive &&
    ((input.role !== undefined && input.role !== "admin") ||
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
  | { ok: false; reason: "not_found" };

/** Reset a staff member's password to a new value. The plaintext password is
 * NEVER logged or returned — only the hash is persisted. */
export async function resetStaffPassword(
  organizationId: string,
  userId: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
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
