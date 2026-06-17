import "server-only";

import { randomUUID, randomBytes } from "node:crypto";
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
 * Tenant provisioning (Stage 9 v1 + self-serve signup).
 *
 * Two callers share the same org-creation core ({@link createOrgCore}):
 *   - {@link provisionOrganization} — the platform-admin path: creates the org
 *     WITHOUT an owner user and WITH `ownerEmail` set, then issues the owner an
 *     invite through the EXISTING staff-invite mechanism (the deferred-promotion
 *     handle that `acceptInvite` consumes). No login/session code is touched.
 *   - `provisionOrgWithOwner` (in src/lib/auth/signup.ts) — the self-serve path:
 *     creates the org WITH the owner user (super_admin, googleId bound) and with
 *     `ownerEmail` NULL (no pending invite to promote later — see B1 below).
 *
 * Atomicity: neon-http has no transactions, so the multi-row create
 * (organization + organization_settings [+ owner user]) goes through ONE
 * `db.batch([...])` executed server-side as a single unit. The org row is FIRST
 * in the batch, so both the settings and users inserts (which FK
 * organizations.id) resolve. IDs are generated client-side via `randomUUID()` so
 * no mid-batch `.returning()` is needed and the caller gets `ownerUserId`. Comms
 * templates are seeded after the batch, best-effort (a seed failure must not
 * abort the provision, per the Stage-9 fix).
 *
 * Role note (Stage-9 invite path): the owner is invited as `admin` — the highest
 * role the staff_invites enum can store. `acceptInvite` promotes that owner to
 * `super_admin` when their email matches the org's stored `ownerEmail`.
 */

/** The invite role used for a new org's owner (Stage-9 path). */
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
  const message = errorMessage(error);
  // The slug index is the only org-level unique constraint touched by this
  // insert; match its column/constraint name (and the generic SQLSTATE)
  // defensively. The googleId check below runs FIRST so a users_google_id_unique
  // violation is never miscategorized as a slug clash.
  return (
    message.includes("organizations_slug_unique") ||
    (message.includes("slug") && message.includes("23505"))
  );
}

/** True when an error is the GLOBAL users.google_id unique-violation
 * (users_google_id_unique). Distinct from the slug clash: a brand-new email with
 * a Google `sub` already bound to another user row must NOT 500 — it's a
 * terminal "this Google account already has an account" (B3). */
function isGoogleIdUniqueViolation(error: unknown): boolean {
  return errorMessage(error).includes("users_google_id_unique");
}

/** True when an error is a GLOBAL users.email unique-violation
 * (users_email_global_unique, or any users-email unique constraint). Distinct
 * from the slug clash and the google-id clash: a brand-new Google sub whose
 * email already belongs to a user in ANOTHER org (race loser) must NOT 500 — it
 * is the same terminal "this account already exists" outcome as google_id_taken.
 * Also matches the per-org index name defensively. */
function isEmailUniqueViolation(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("users_email_global_unique") ||
    message.includes("users_org_email_unique")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
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

/** A short random suffix appended to a slug on a uniqueness clash so signup (and
 * provisioning) never hard-fail on a name collision. */
function slugSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** The owner user to create inside the batch (self-serve path). */
export interface OrgOwnerUser {
  readonly email: string;
  readonly name: string | null;
  /** Google `sub`, bound at creation = account-takeover guard. */
  readonly googleId: string;
}

export interface CreateOrgCoreInput {
  readonly name: string;
  /** User id of the actor performing the create (platform admin for Stage 9;
   * null for self-serve, where there is no pre-existing actor). Audit trace. */
  readonly createdBy: string | null;
  /** Deferred-promotion handle for the Stage-9 invite path. NULL on the
   * self-serve path (B1): the owner is created super_admin directly, so leaving
   * ownerEmail set would strand a live acceptInvite promotion + PII. */
  readonly ownerEmail: string | null;
  /** When present, the owner user is created super_admin inside the same batch
   * (self-serve path). When absent, no user is created (Stage-9 invite path). */
  readonly ownerUser?: OrgOwnerUser;
  /** When true, a slug unique-violation is returned as `slug_conflict` instead
   * of being auto-suffixed. The Stage-9 admin path surfaces the clash so the
   * admin can pick a new name; the self-serve path auto-suffixes (default). */
  readonly slugConflictIsTerminal?: boolean;
  /** When true, the org-count cap check is skipped (the caller already ran it).
   * The Stage-9 path checks the cap itself before its slug/email pre-checks. */
  readonly skipOrgCountCheck?: boolean;
}

export interface CreateOrgCoreResult {
  readonly organizationId: string;
  /** Present only when an ownerUser was created in the batch. */
  readonly ownerUserId?: string;
}

export type CreateOrgCoreError =
  | { kind: "invalid_name" }
  | { kind: "org_limit_reached" }
  | { kind: "google_id_taken" }
  | { kind: "email_taken" }
  | { kind: "slug_conflict" };

export type CreateOrgCoreOutcome =
  | { ok: true; result: CreateOrgCoreResult }
  | { ok: false; error: CreateOrgCoreError };

/**
 * Shared org-creation core for both provisioning paths.
 *
 * Runs the org-count cap check, then ONE `db.batch` ordered
 * `[organizations, organizationSettings, users?]` (org FIRST). On a slug unique
 * violation it retries once with a short random suffix; on the GLOBAL
 * users_google_id_unique violation it returns `google_id_taken` (mapped by the
 * caller to a redirect, not a 500). Seeds comms templates best-effort after the
 * batch. Returns the new ids.
 */
export async function createOrgCore(
  input: CreateOrgCoreInput,
): Promise<CreateOrgCoreOutcome> {
  const baseSlug = deriveSlug(input.name);
  if (baseSlug.length === 0) {
    return { ok: false, error: { kind: "invalid_name" } };
  }

  // Hard org-count cap (SOFT ceiling — racy under concurrency, small bounded
  // overshoot). The route's in-memory rate limiter can't throttle org creation
  // across serverless instances, so this DB-backed count is the ceiling.
  if (!input.skipOrgCountCheck) {
    const maxOrgs = resolveMaxOrgs();
    const [orgCountRow] = await db
      .select({ value: count() })
      .from(organizations);
    // neon-http returns count() as a string.
    const orgCount = Number(orgCountRow?.value ?? 0);
    if (orgCount >= maxOrgs) {
      return { ok: false, error: { kind: "org_limit_reached" } };
    }
  }

  const organizationId = randomUUID();
  const ownerUserId = input.ownerUser ? randomUUID() : undefined;
  const name = input.name.trim();

  // Build the batch statements once; only the slug differs across the retry. The
  // batch is ordered [organizations, organizationSettings, users?]: the org row
  // exists by the time the FK-bearing settings/users inserts run.
  const runBatch = (slug: string) => {
    const orgStmt = db.insert(organizations).values({
      id: organizationId,
      name,
      slug,
      status: "active",
      createdBy: input.createdBy,
      ownerEmail: input.ownerEmail,
    });
    const settingsStmt = db
      .insert(organizationSettings)
      .values({ organizationId });
    // A non-empty tuple ordered [organizations, organizationSettings, users?]:
    // the org row exists by the time the FK-bearing inserts run.
    if (input.ownerUser && ownerUserId) {
      const userStmt = db.insert(users).values({
        id: ownerUserId,
        organizationId,
        email: input.ownerUser.email,
        name: input.ownerUser.name ?? input.ownerUser.email,
        role: "super_admin",
        googleId: input.ownerUser.googleId,
        isActive: true,
      });
      return db.batch([orgStmt, settingsStmt, userStmt]);
    }
    return db.batch([orgStmt, settingsStmt]);
  };

  try {
    await runBatch(baseSlug);
  } catch (error: unknown) {
    // GLOBAL Google-id clash (B3): brand-new email, but the sub is already bound
    // to another user. Terminal — caller redirects to login, not a 500.
    if (isGoogleIdUniqueViolation(error)) {
      return { ok: false, error: { kind: "google_id_taken" } };
    }
    // GLOBAL email clash: a concurrent same-email signup (different Google sub)
    // won the race and provisioned first. Same terminal outcome as the google-id
    // clash — caller redirects to login, NOT a 500. The B2 pre-check is racy; the
    // global unique index is the authoritative backstop.
    if (isEmailUniqueViolation(error)) {
      return { ok: false, error: { kind: "email_taken" } };
    }
    // Slug clash: the Stage-9 admin path surfaces it (slug_conflict) so the
    // admin renames; the self-serve path retries ONCE with a random suffix so
    // signup never hard-fails on a name collision (B3 auto-suffix). A second
    // clash is astronomically unlikely; let it throw (→ caller's try_again).
    if (isSlugUniqueViolation(error)) {
      if (input.slugConflictIsTerminal) {
        return { ok: false, error: { kind: "slug_conflict" } };
      }
      try {
        await runBatch(`${baseSlug}-${slugSuffix()}`.slice(0, 80));
      } catch (retryError: unknown) {
        if (isGoogleIdUniqueViolation(retryError)) {
          return { ok: false, error: { kind: "google_id_taken" } };
        }
        if (isEmailUniqueViolation(retryError)) {
          return { ok: false, error: { kind: "email_taken" } };
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  // Seed default comms templates for the new org (idempotent per-org inserts).
  // Best-effort: a missing template set is far less damaging than a failed
  // provision, so a seed failure must NOT abort. Log a warning (org id only — no
  // PII) and continue.
  try {
    await seedCommunicationTemplates(organizationId);
  } catch (error: unknown) {
    logger.warn(
      { error, organizationId },
      "Failed to seed communication templates for new org; continuing",
    );
  }

  return { ok: true, result: { organizationId, ownerUserId } };
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
 * Provision a new tenant org for `ownerEmail` (platform-admin / Stage-9 path).
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
 *
 * Behavior is UNCHANGED from before the createOrgCore refactor: it calls
 * createOrgCore WITHOUT an ownerUser and WITH ownerEmail set, then creates the
 * owner invite.
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
  const [orgCountRow] = await db.select({ value: count() }).from(organizations);
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

  // Create the org + settings via the shared core: ONE batch (no ownerUser, so
  // exactly [organizations, organizationSettings]), ownerEmail SET (the
  // deferred-promotion handle acceptInvite consumes), slug clash surfaced as
  // slug_conflict (admin renames), and templates seeded best-effort. The cap was
  // already checked above, so skip the re-check.
  const created = await createOrgCore({
    name: input.name,
    createdBy: input.createdBy,
    ownerEmail,
    slugConflictIsTerminal: true,
    skipOrgCountCheck: true,
  });
  if (!created.ok) {
    // createOrgCore can only return invalid_name (excluded by the slug guard
    // above) or slug_conflict on this path (no ownerUser → no google_id_taken;
    // cap skipped). Map slug_conflict; anything else is a programming error.
    if (created.error.kind === "slug_conflict") {
      return { ok: false, reason: "slug_conflict" };
    }
    throw new Error(
      `Unexpected createOrgCore error on invite path: ${created.error.kind}`,
    );
  }
  const { organizationId } = created.result;

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
