import "server-only";

import { randomBytes, createHash } from "node:crypto";
import { and, eq, asc, gt, isNull, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { staffInvites, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canAssignRole } from "@/lib/auth/authz";
import type { AdminRole, AdminSessionPayload } from "@/lib/auth/types";
import { normalizeEmail, createStaff } from "./staff-queries";

/**
 * Team invitations — tokenized, copyable signup links (no email dependency).
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

/** Project a (wider) session role onto the AdminRole the authz policy uses.
 * Only super_admin is privileged; anything else is confined to technicians. */
function toActorRole(role: AdminSessionPayload["role"]): AdminRole {
  return role === "super_admin" ? "super_admin" : "admin";
}

export type CreateInviteResult =
  | { ok: true; invite: InviteRecord; token: string }
  | {
      ok: false;
      reason: "forbidden" | "email_conflict" | "invite_exists";
    };

/**
 * Create an invite for `email` to join `organizationId` as `role`.
 *
 * @param actorRole role of the admin creating the invite (authz gate)
 * @param invitedByUserId id of that admin (trace)
 */
export async function createInvite(
  organizationId: string,
  input: { email: string; role: InvitableRole },
  actorRole: AdminSessionPayload["role"],
  invitedByUserId: string,
): Promise<CreateInviteResult> {
  // Privilege-escalation guard (policy in authz.ts). canAssignRole also rejects
  // "super_admin" for a super_admin actor, but the column enum already makes
  // super_admin un-storable; we never accept it as input.
  if (!canAssignRole(toActorRole(actorRole), input.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const email = normalizeEmail(input.email);

  // Refuse if a user with this email already exists in the org — invite is for
  // NEW teammates; managing existing ones goes through the staff surface.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.email, email)))
    .limit(1);
  if (existingUser) {
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

  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  const [created] = await db
    .insert(staffInvites)
    .values({
      organizationId,
      email,
      role: input.role,
      tokenHash,
      invitedByUserId,
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
    },
  };
}

export interface AcceptedInvite {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  readonly role: InvitableRole;
  /** A ready-to-mint admin session, present ONLY for an admin-role invite. A
   * technician holds no admin session (verifyToken rejects it), so this is null
   * for technician invites — the account is created and the recipient is told to
   * use the field-staff entry point, not the admin dashboard. */
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

  // Create the user in the invite's OWN org, with the invite's role, BEFORE
  // claiming the invite. Internal call: actorRole defaults to super_admin (the
  // inviting admin's authority was checked at create time; the role is fixed by
  // the trusted invite row, never by request input). The unique email index
  // makes this the race arbiter — a duplicate create returns email_conflict.
  const created = await createStaff(invite.organizationId, {
    name: input.name,
    email: invite.email,
    password: input.password,
    role: invite.role,
  });

  if (!created.ok) {
    // email_conflict: a user with this email already exists in the org (created
    // concurrently or after the invite). The invite is left UN-claimed; there is
    // nothing to roll back. This is terminal for the invite (the email is taken).
    return { ok: false, reason: "email_conflict" };
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

  // Only an admin-role invite yields an admin session. A technician invite
  // creates the user but mints no admin cookie (technician is not a session
  // role). invite.role is the trusted source — created.staff.role echoes it.
  const session: AdminSessionPayload | null =
    invite.role === "admin"
      ? {
          userId: created.staff.id,
          organizationId: invite.organizationId,
          email: created.staff.email,
          name: created.staff.name,
          role: "admin",
        }
      : null;

  return {
    ok: true,
    accepted: {
      userId: created.staff.id,
      organizationId: invite.organizationId,
      email: created.staff.email,
      name: created.staff.name,
      role: invite.role,
      session,
    },
  };
}
