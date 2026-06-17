import "server-only";

import { randomUUID } from "node:crypto";
import { eq, count } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizations,
  organizationSettings,
  users,
  staffInvites,
} from "@/lib/db/schema";
import { seedCommunicationTemplates } from "@/lib/communication/seeds";
import { logger } from "@/lib/logger";
import {
  generateInviteToken,
  INVITE_TTL_MS,
  type InviteRecord,
} from "./invites";
import { normalizeEmail } from "./staff-queries";

/**
 * Tenant provisioning (Stage 9 v1).
 *
 * Creates a brand-new organization plus its baseline rows, then issues the
 * owner an invite through the EXISTING staff-invite mechanism. No login/session
 * code is touched: the owner accepts the invite via the unchanged accept flow,
 * signs in with Google, and runs the new org as its first admin.
 *
 * Atomicity: neon-http has no transactions, so the multi-row create
 * (organization + organization_settings) goes through ONE `db.batch([...])`
 * (executed server-side as a single round trip). Comms templates are seeded
 * after (idempotent per-org inserts), and the owner invite is created last.
 *
 * Role note (v1): the owner is invited as `admin` — the highest role the
 * staff_invites enum can store and the only one the proven accept flow grants
 * unchanged. Because a freshly-provisioned org has NO other users, that admin is
 * the org's sole top-tier operator. Promoting the owner to `super_admin` is left
 * to a follow-up (it would require either touching the invite enum or the accept
 * flow, both out of scope for this safe v1). `organizations.ownerEmail` records
 * who the org belongs to so a later promotion step can find them.
 */

/** The invite role used for a new org's owner. See the role note above. */
const OWNER_INVITE_ROLE = "admin" as const;

/** Default hard cap on the number of orgs when PLATFORM_MAX_ORGS is unset,
 * blank, zero, or otherwise invalid. */
const DEFAULT_MAX_ORGS = 100;

/**
 * Resolve the hard org-count cap from PLATFORM_MAX_ORGS. The in-memory rate
 * limiter on the route cannot throttle org creation across serverless instances,
 * so this DB-backed count is the authoritative ceiling. A blank/zero/invalid
 * value falls back to DEFAULT_MAX_ORGS — never "unlimited".
 */
function resolveMaxOrgs(): number {
  const parsed = Number.parseInt(process.env.PLATFORM_MAX_ORGS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ORGS;
}

/** True when an error is the slug unique-violation on organizations (the
 * `.unique()` on organizations.slug, Postgres SQLSTATE 23505). Mirrors the
 * isUniqueEmailViolation pattern in staff-queries: match on a stable token in
 * the message so it survives neon-http error wrapping. */
function isSlugUniqueViolation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  // The slug index is the only unique constraint touched by this insert; match
  // its column/constraint name (and the generic SQLSTATE) defensively.
  return (
    message.includes("organizations_slug_unique") ||
    message.includes("slug") && message.includes("23505") ||
    message.includes("23505")
  );
}

/**
 * Derive a URL-safe slug from a business name: lowercase, non-alphanumerics →
 * hyphens, collapsed, trimmed. Returns "" when the name has no usable
 * characters (caller rejects that as invalid).
 */
export function deriveSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface ProvisionInput {
  readonly name: string;
  readonly ownerEmail: string;
  /** User id of the platform admin performing the provisioning (audit trace). */
  readonly createdBy: string;
}

export interface ProvisionedOrg {
  readonly organizationId: string;
  readonly ownerInvite: InviteRecord;
  /** Plaintext invite token — returned exactly once, never stored. */
  readonly inviteToken: string;
}

export type ProvisionResult =
  | { ok: true; provisioned: ProvisionedOrg }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "slug_conflict"
        | "owner_email_in_use"
        | "org_limit_reached";
    };

/**
 * Provision a new tenant org for `ownerEmail`.
 *
 * Rejects (clean sentinels, no throw) when:
 *   - the name yields no usable slug ("invalid_name"),
 *   - an org with the derived slug already exists ("slug_conflict"),
 *   - the owner email already belongs to ANY user ("owner_email_in_use") — a
 *     person who is already a user somewhere is not a fresh-org owner in v1.
 *
 * The owner email is checked GLOBALLY (across orgs) on purpose: the per-org
 * unique-email index only guards within one org, and a v1 owner should be a new
 * principal, not an existing user being re-homed.
 */
export async function provisionOrganization(
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const slug = deriveSlug(input.name);
  if (slug.length === 0) {
    return { ok: false, reason: "invalid_name" };
  }

  const ownerEmail = normalizeEmail(input.ownerEmail);

  // Hard org-count cap. The route's in-memory rate limiter can't throttle org
  // creation across serverless instances, so this DB-backed count is the
  // authoritative ceiling against runaway/abusive tenant creation.
  const maxOrgs = resolveMaxOrgs();
  const [orgCountRow] = await db
    .select({ value: count() })
    .from(organizations);
  // neon-http returns count() as a string.
  const orgCount = Number(orgCountRow?.value ?? 0);
  if (orgCount >= maxOrgs) {
    return { ok: false, reason: "org_limit_reached" };
  }

  // Slug must be free (slug is globally unique on organizations).
  const [slugTaken] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (slugTaken) {
    return { ok: false, reason: "slug_conflict" };
  }

  // Owner email must not already belong to a user anywhere.
  const [emailTaken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ownerEmail))
    .limit(1);
  if (emailTaken) {
    return { ok: false, reason: "owner_email_in_use" };
  }

  // Generate the org id client-side so the batched settings insert can reference
  // it without a round trip for .returning().
  const organizationId = randomUUID();

  // ONE batch: organization + its settings row (defaults fill the NOT-NULL JSON
  // columns). neon-http runs the batch as a single server-side unit.
  //
  // The slug pre-check above is racy: two concurrent provisions with the same
  // name both see a free slug, then the DB `.unique()` rejects the loser. Catch
  // that unique-violation and return the same slug_conflict sentinel rather than
  // surfacing a 500 (mirrors createStaff's isUniqueEmailViolation handling).
  try {
    await db.batch([
      db.insert(organizations).values({
        id: organizationId,
        name: input.name.trim(),
        slug,
        status: "active",
        createdBy: input.createdBy,
        ownerEmail,
      }),
      db.insert(organizationSettings).values({
        organizationId,
      }),
    ]);
  } catch (error: unknown) {
    if (isSlugUniqueViolation(error)) {
      return { ok: false, reason: "slug_conflict" };
    }
    throw error;
  }

  // Seed default comms templates for the new org (idempotent per-org inserts).
  // Best-effort: a missing template set is far less damaging than the owner
  // having NO way into their org, so a seed failure must NOT block the owner
  // invite below. Log a warning (org id only — no PII) and continue.
  try {
    await seedCommunicationTemplates(organizationId);
  } catch (error: unknown) {
    logger.warn(
      { error, organizationId },
      "Failed to seed communication templates for new org; continuing to owner invite",
    );
  }

  // Issue the owner invite through the EXISTING mechanism. We create the invite
  // row directly here (not via createInvite) because createInvite reads/writes
  // within the inviting admin's OWN org, and a fresh org has no users yet. The
  // token/hash/TTL/role semantics are identical to createInvite; the unchanged
  // accept flow is what consumes it. invited_by_user_id is the PLATFORM admin's
  // user id (a real users.id row in their own org) — the FK only requires a
  // valid user, not a same-org one, so this is a faithful provenance record.
  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [createdInvite] = await db
    .insert(staffInvites)
    .values({
      organizationId,
      email: ownerEmail,
      role: OWNER_INVITE_ROLE,
      tokenHash,
      invitedByUserId: input.createdBy,
      expiresAt,
    })
    .returning({
      id: staffInvites.id,
      email: staffInvites.email,
      role: staffInvites.role,
      expiresAt: staffInvites.expiresAt,
      createdAt: staffInvites.createdAt,
    });

  if (!createdInvite) {
    throw new Error("Failed to create owner invite");
  }

  return {
    ok: true,
    provisioned: {
      organizationId,
      inviteToken: token,
      ownerInvite: {
        id: createdInvite.id,
        email: createdInvite.email,
        role: createdInvite.role,
        expiresAt: createdInvite.expiresAt.toISOString(),
        createdAt: createdInvite.createdAt.toISOString(),
      },
    },
  };
}
