import "server-only";

import { randomBytes, createHash } from "node:crypto";
import { and, eq, asc, gt, isNull, desc, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { staffInvites, users, organizations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import {
  canAssignRole,
  assertMayMutateUser,
  isPlatformAdmin,
  type MutationActor,
} from "@/lib/auth/authz";
import type { AdminRole, AdminSessionPayload } from "@/lib/auth/types";
import { isRetiredDemoEmail } from "@/lib/auth/retired-demo";
import { normalizeEmail, createStaff, claimPasswordlessStaff } from "./staff-queries";
import { getSeatUsage } from "./seats";
import { seatsFull } from "./seat-usage";

/**
 * Team invitations — tokenized signup links, emailed when Resend is configured
 * (invite-email.ts) and otherwise shown once to copy.
 *
 * An admin creates an invite for an email + role. We generate a 256-bit random
 * token, return its PLAINTEXT exactly once (embedded in the accept link), and
 * store only its SHA-256 hash — the plaintext is unrecoverable afterward
 * (mirrors src/lib/widget/keys.ts). The recipient opens the link, sets a name +
 * password, and a user row is created with the role taken from the INVITE ROW,
 * never from request input.
 *
 * Invariants enforced here (so they hold no matter who calls):
 *   - An invite can only ever grant `admin` or `technician`. `super_admin` is
 *     never invitable.
 *   - Authorization reuses the single policy source (authz.ts): a normal admin
 *     may invite only technicians; a super_admin may invite admins too.
 *   - Single-use (accepted_at), expiring (72h), revocable (revoked_at).
 *   - Org-scoped throughout — an invite for one org can never resolve into
 *     another, and accept creates the user in the invite's own org.
 */

/** Role an invite may grant. Deliberately excludes super_admin. */
export type InvitableRole = "admin" | "technician";

/** How long a fresh invite stays valid. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/** Random bytes in the token body (32 bytes → 64 hex chars → 256-bit). */
const TOKEN_BYTES = 32;

export interface InviteRecord {
  readonly id: string;
  readonly email: string;
  readonly role: InvitableRole;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** SHA-256 hex of an invite token. Deterministic, so a presented token can be
 * looked up by hash (the column is indexed + unique). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Generate a fresh invite token: plaintext (returned once) + its stored hash. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  return { token, tokenHash: hashInviteToken(token) };
}

function toInviteRecord(row: {
  id: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
  createdAt: Date;
}): InviteRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export type CreateInviteResult =
  | { ok: true; invite: InviteRecord; token: string }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "platform_protected"
        | "email_conflict"
        | "invite_exists"
        | "seat_limit";
    };

/**
 * Create an invite for `email` to join `organizationId` as `role`.
 *
 * @param actor the admin creating the invite (authz gate). Recorded as the
 *   invite's inviter, whose authority is re-checked when the invite is accepted.
 */
export async function createInvite(
  organizationId: string,
  input: { email: string; role: InvitableRole },
  actor: MutationActor,
): Promise<CreateInviteResult> {
  // Privilege-escalation guard (policy in authz.ts). canAssignRole also rejects
  // "super_admin" for a super_admin actor, but the column enum already makes
  // super_admin un-storable; we never accept it as input.
  if (!canAssignRole(actor.role, input.role)) {
    return { ok: false, reason: "forbidden" };
  }
  // An invite can claim or create a row for its email, so a platform admin's
  // email is never invitable by anyone but a platform admin.
  if (!assertMayMutateUser(actor, { newEmail: input.email }).ok) {
    return { ok: false, reason: "platform_protected" };
  }

  const email = normalizeEmail(input.email);

  // An existing user normally blocks the invite (invites are for NEW
  // teammates) — EXCEPT the credential-setup case: an ACTIVE user with NO
  // password and exactly the invite's role (e.g. a FieldPulse-synced
  // technician) may be invited so the accept flow can set their first
  // password. A password-bearing, inactive, or role-mismatched user still
  // conflicts.
  const [existingUser] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      role: users.role,
    })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.email, email)))
    .limit(1);
  const credentialSetup =
    existingUser != null &&
    existingUser.passwordHash === null &&
    existingUser.isActive &&
    existingUser.role === input.role;
  if (existingUser && !credentialSetup) {
    return { ok: false, reason: "email_conflict" };
  }

  // Refuse a duplicate LIVE invite (not accepted, not revoked, not expired).
  // The partial unique index covers accepted/revoked; expiry is checked here.
  const now = new Date();
  const [liveInvite] = await db
    .select({ id: staffInvites.id })
    .from(staffInvites)
    .where(
      withTenant(
        staffInvites,
        organizationId,
        eq(staffInvites.email, email),
        isNull(staffInvites.acceptedAt),
        isNull(staffInvites.revokedAt),
        gt(staffInvites.expiresAt, now),
      ),
    )
    .limit(1);
  if (liveInvite) {
    return { ok: false, reason: "invite_exists" };
  }

  // Seat-limit entitlement gate (Stage 10). An invite, once accepted, becomes a
  // new active user, so block it when the org is already AT its plan's maxStaff.
  // Count active users only (deactivated users don't consume a seat). The free
  // tier's small cap is the floor for a NULL-plan org. This is the ONE
  // representative entitlement enforcement in v1. SKIPPED for credential-setup
  // invites: the existing user already holds their seat.
  if (!credentialSetup) {
    if (seatsFull(await getSeatUsage(organizationId))) {
      return { ok: false, reason: "seat_limit" };
    }
  }

  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  const [created] = await db
    .insert(staffInvites)
    .values({
      organizationId,
      email,
      role: input.role,
      tokenHash,
      invitedByUserId: actor.userId,
      expiresAt,
    })
    .returning({
      id: staffInvites.id,
      email: staffInvites.email,
      role: staffInvites.role,
      expiresAt: staffInvites.expiresAt,
      createdAt: staffInvites.createdAt,
    });

  if (!created) {
    throw new Error("Failed to create invite");
  }

  return { ok: true, invite: toInviteRecord(created), token };
}

/** Rolling window for the per-org invite email cap (plan ruling 4). */
const INVITE_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many invites this org created in the last 24 hours. Callers read it
 * BEFORE creating the new invite, so the count excludes it (plan ruling 4).
 */
export async function inviteEmailsLast24h(organizationId: string): Promise<number> {
  const since = new Date(Date.now() - INVITE_EMAIL_WINDOW_MS);
  const [row] = await db
    .select({ value: count() })
    .from(staffInvites)
    .where(withTenant(staffInvites, organizationId, gt(staffInvites.createdAt, since)));
  return Number(row?.value ?? 0);
}

/** The org's name and pending owner email, for the platform owner invite.
 * Null when the org doesn't exist. */
export async function getOwnerInviteTarget(
  organizationId: string,
): Promise<{ name: string; ownerEmail: string | null } | null> {
  const [row] = await db
    .select({ name: organizations.name, ownerEmail: organizations.ownerEmail })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ? { name: row.name, ownerEmail: row.ownerEmail ?? null } : null;
}

/** List PENDING invites for an org: not accepted, not revoked, not expired. */
export async function listInvites(
  organizationId: string,
): Promise<readonly InviteRecord[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: staffInvites.id,
      email: staffInvites.email,
      role: staffInvites.role,
      expiresAt: staffInvites.expiresAt,
      createdAt: staffInvites.createdAt,
    })
    .from(staffInvites)
    .where(
      withTenant(
        staffInvites,
        organizationId,
        isNull(staffInvites.acceptedAt),
        isNull(staffInvites.revokedAt),
        gt(staffInvites.expiresAt, now),
      ),
    )
    .orderBy(desc(staffInvites.createdAt), asc(staffInvites.email));

  return rows.map(toInviteRecord);
}

/** Return the role of a pending invite for authz checks, or null if not found. */
export async function getInviteRole(
  organizationId: string,
  inviteId: string,
): Promise<InvitableRole | null> {
  const [row] = await db
    .select({ role: staffInvites.role })
    .from(staffInvites)
    .where(withTenant(staffInvites, organizationId, eq(staffInvites.id, inviteId)))
    .limit(1);
  return row?.role ?? null;
}

export type RevokeInviteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

/** Revoke a pending invite (org-scoped). Idempotent on already-revoked rows
 * (still returns ok). Returns not_found if the id isn't in this org. */
export async function revokeInvite(
  organizationId: string,
  inviteId: string,
): Promise<RevokeInviteResult> {
  const [updated] = await db
    .update(staffInvites)
    .set({ revokedAt: new Date() })
    .where(withTenant(staffInvites, organizationId, eq(staffInvites.id, inviteId)))
    .returning({ id: staffInvites.id });

  if (!updated) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true };
}

export type ResolveInviteResult =
  | {
      ok: true;
      invite: {
        readonly id: string;
        readonly organizationId: string;
        readonly email: string;
        readonly role: InvitableRole;
        readonly invitedByUserId: string | null;
      };
    }
  | { ok: false; reason: "not_found" | "expired" | "used" | "revoked" };

/**
 * Resolve a plaintext token to its live invite, or a denial reason. Looks the
 * token up by hash (indexed + unique). The denial reasons are distinct so the
 * accept PAGE can show a precise message — but the public accept ROUTE collapses
 * them to a single generic error to avoid enumeration.
 */
export async function resolveInviteByToken(
  token: string,
): Promise<ResolveInviteResult> {
  const tokenHash = hashInviteToken(token);

  const [row] = await db
    .select({
      id: staffInvites.id,
      organizationId: staffInvites.organizationId,
      email: staffInvites.email,
      role: staffInvites.role,
      invitedByUserId: staffInvites.invitedByUserId,
      expiresAt: staffInvites.expiresAt,
      acceptedAt: staffInvites.acceptedAt,
      revokedAt: staffInvites.revokedAt,
    })
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.revokedAt !== null) {
    return { ok: false, reason: "revoked" };
  }
  if (row.acceptedAt !== null) {
    return { ok: false, reason: "used" };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    invite: {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      invitedByUserId: row.invitedByUserId,
    },
  };
}

/**
 * Load an invite's inviter as a MutationActor (plan ruling 6). Looks in ANY org:
 * a provisioned org's owner invite is created by the platform admin, whose row
 * lives in the platform org. Returns null unless the user exists, is active, and
 * is still admin-tier — an invite from someone who has since left or been
 * demoted to technician carries no authority.
 */
export async function loadInviter(
  userId: string | null,
): Promise<MutationActor | null> {
  if (!userId) return null;
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.isActive) return null;
  if (row.role !== "super_admin" && row.role !== "admin") return null;
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    organizationId: row.organizationId,
  };
}

/**
 * Whether accepting this invite promotes its acceptor to the org's super_admin
 * (spec P2). All three must hold: the invite email matches the org's stored
 * owner email (normalized), the invite grants `admin`, and the inviter is a
 * PLATFORM admin. An org admin inviting the owner's address — as a technician
 * or an admin — never mints a super_admin.
 */
export function isOwnerPromotion(p: {
  ownerEmail: string | null;
  inviteEmail: string;
  inviteRole: InvitableRole;
  inviter: MutationActor | null;
}): boolean {
  if (p.ownerEmail === null) return false;
  const owner = normalizeEmail(p.ownerEmail);
  if (owner === "" || owner !== normalizeEmail(p.inviteEmail)) return false;
  if (p.inviteRole !== "admin") return false;
  return p.inviter !== null && isPlatformAdmin(p.inviter);
}

export interface AcceptedInvite {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  /** The EFFECTIVE role the new user holds. Normally the invite's role
   * (admin/technician). For the org's owner (isOwnerPromotion: a platform
   * admin's admin invite to the org's stored ownerEmail) this is promoted to
   * `super_admin` — see the owner special-case in acceptInvite. */
  readonly role: AdminRole | "technician";
  /** A ready-to-mint admin session, present ONLY for an admin-tier invite (admin
   * or the promoted owner's super_admin). A technician holds no admin session
   * (verifyToken rejects it), so this is null for technician invites — the
   * account is created and the recipient is told to use the field-staff entry
   * point, not the admin dashboard. */
  readonly session: AdminSessionPayload | null;
}

export type AcceptInviteResult =
  | { ok: true; accepted: AcceptedInvite }
  | {
      ok: false;
      reason: "invalid" | "email_conflict";
    };

/**
 * Consume an invite: create the user with the role FROM THE INVITE ROW (never
 * from request input), mark the invite accepted (single-use), and return the
 * new user (plus an admin session payload when the role is admin-tier).
 *
 * Concurrency: neon-http has no transactions. We CREATE THE USER FIRST, then
 * claim the invite (conditional UPDATE … WHERE accepted_at IS NULL). Ordering
 * this way means there is no rollback to lose: the per-org unique email index
 * (users_org_email_unique) is the hard backstop, so two concurrent accepts of
 * the same invite can't both create a user — the loser gets email_conflict and
 * never claims. A crash between create and claim leaves a live invite + a real
 * user; re-accepting then hits email_conflict (a clean terminal state) rather
 * than silently burning the invite with no account behind it.
 */
export async function acceptInvite(
  token: string,
  input: { name: string; password: string },
): Promise<AcceptInviteResult> {
  const resolved = await resolveInviteByToken(token);
  if (!resolved.ok) {
    return { ok: false, reason: "invalid" };
  }
  const { invite } = resolved;
  // Retired demo logins can never be (re)created through an invite.
  if (isRetiredDemoEmail(invite.email)) {
    return { ok: false, reason: "invalid" };
  }

  // The actor is the inviter, re-loaded NOW (plan ruling 6): an invite from
  // someone who has left, been deactivated, or lost the authority to grant this
  // role (e.g. a super_admin since demoted to admin) is no longer valid.
  const inviter = await loadInviter(invite.invitedByUserId);
  if (!inviter || !canAssignRole(inviter.role, invite.role)) {
    return { ok: false, reason: "invalid" };
  }

  // Create the user in the invite's OWN org, with the invite's role, BEFORE
  // claiming the invite. The role is fixed by the trusted invite row, never by
  // request input; the inviter's current authority is the actor. The unique
  // email index makes this the race arbiter — a duplicate create returns
  // email_conflict.
  const created = await createStaff(
    invite.organizationId,
    {
      name: input.name,
      email: invite.email,
      password: input.password,
      role: invite.role,
    },
    inviter,
  );
  // A refusal (e.g. a platform admin's email invited by an org admin) never
  // falls through to claiming the existing row.
  if (
    !created.ok &&
    (created.reason === "forbidden" || created.reason === "platform_protected")
  ) {
    return { ok: false, reason: "invalid" };
  }

  // The accepted identity: a NEWLY created user, or — when the email already
  // belongs to an ACTIVE PASSWORD-LESS user with the invite's role (e.g. a
  // FieldPulse-synced technician) — that EXISTING user, whose first password
  // this invite sets (credential-setup). The existing user keeps their own
  // name; the form's name is ignored. Any other conflict stays terminal.
  let staff: { id: string; email: string; name: string };
  if (created.ok) {
    staff = created.staff;
  } else {
    const claimed = await claimPasswordlessStaff(
      invite.organizationId,
      {
        email: invite.email,
        role: invite.role,
        password: input.password,
      },
      inviter,
    );
    if (
      !claimed.ok &&
      (claimed.reason === "forbidden" || claimed.reason === "platform_protected")
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (!claimed.ok) {
      // email_conflict: a user with this email already exists in the org and is
      // not claimable (has a password / inactive / different role). The invite
      // is left UN-claimed; there is nothing to roll back.
      return { ok: false, reason: "email_conflict" };
    }
    staff = claimed.staff;
  }

  // User exists now — claim the invite so it can't be reused. Conditional on
  // accepted_at IS NULL purely for hygiene; the unique index already prevented a
  // second user, so even an unguarded write here would be safe.
  await db
    .update(staffInvites)
    .set({ acceptedAt: new Date() })
    .where(
      and(eq(staffInvites.id, invite.id), isNull(staffInvites.acceptedAt)),
    );

  // --- Owner promotion (the org's recorded owner only) ---
  // The staff_invites enum can never store `super_admin`, so a normal invite can
  // NEVER grant it (createInvite/canAssignRole are untouched). The ONE safe
  // exception: an org records its intended owner in organizations.ownerEmail,
  // and the platform admin issues that owner an `admin` invite. Only then
  // (isOwnerPromotion: email match + admin role + platform-admin inviter) is the
  // acceptor promoted to super_admin. The promotion is a single org-scoped UPDATE
  // (never cross-org), and ownerEmail is then consumed (set NULL) so the stored
  // PII is removed and the promotion can't re-fire.
  let effectiveRole: AdminRole | "technician" = invite.role;

  // Read ownerEmail from the ORGANIZATIONS row (not the invite). NULL for legacy
  // orgs and any org whose owner already accepted — handled safely below.
  const [org] = await db
    .select({ ownerEmail: organizations.ownerEmail })
    .from(organizations)
    .where(eq(organizations.id, invite.organizationId))
    .limit(1);

  const isProvisionedOwner = isOwnerPromotion({
    ownerEmail: org?.ownerEmail ?? null,
    inviteEmail: invite.email,
    inviteRole: invite.role,
    inviter,
  });

  if (isProvisionedOwner) {
    // Targeted, org-scoped promotion: only this user, only in this org.
    await db
      .update(users)
      .set({ role: "super_admin", updatedAt: new Date() })
      .where(
        and(
          eq(users.id, staff.id),
          eq(users.organizationId, invite.organizationId),
        ),
      );

    // Consume the owner claim: removes the stored PII and prevents re-promotion.
    await db
      .update(organizations)
      .set({ ownerEmail: null, updatedAt: new Date() })
      .where(eq(organizations.id, invite.organizationId));

    effectiveRole = "super_admin";
  }

  // An admin-tier effective role yields an admin session. A technician invite
  // creates the user but mints no admin cookie (technician is not a session
  // role). The session role is the EFFECTIVE role: super_admin for the promoted
  // owner, otherwise the invite's role.
  const session: AdminSessionPayload | null =
    effectiveRole === "technician"
      ? null
      : {
          userId: staff.id,
          organizationId: invite.organizationId,
          email: staff.email,
          name: staff.name,
          role: effectiveRole,
        };

  return {
    ok: true,
    accepted: {
      userId: staff.id,
      organizationId: invite.organizationId,
      email: staff.email,
      name: staff.name,
      role: effectiveRole,
      session,
    },
  };
}
