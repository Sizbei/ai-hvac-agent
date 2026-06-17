import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createOrgCore } from "@/lib/admin/provisioning";
import { normalizeEmail } from "@/lib/admin/staff-queries";
import type { AdminSessionPayload } from "./types";
import type { VerifiedGoogleIdentity } from "./google-oidc";

/**
 * Self-serve signup brains (no HTTP). The callback route is thin; this module
 * holds the new-vs-existing decision and the org-with-owner provisioning so it
 * is unit-testable in isolation.
 *
 * POLICY (distinct from login's resolveGoogleLogin, which is UNCHANGED):
 *   - The caller MUST have already verified the id_token (signature, iss/aud/exp,
 *     nonce) and confirmed email_verified === true.
 *   - B2 (existing-email guard): the email is checked GLOBALLY / cross-org —
 *     `db.select().from(users).where(eq(users.email, normalized)).limit(1)`. The
 *     users unique index is PER-ORG, so there is no org filter; ANY hit means the
 *     person already has an account somewhere (even as an admin of a DIFFERENT
 *     org) and signup provisions NOTHING — they are sent to login. This never
 *     creates a 2nd org for an existing user, and never escalates an existing
 *     row.
 *   - B1: the new owner is created super_admin DIRECTLY (no invite), with the
 *     org's `ownerEmail` left NULL so no acceptInvite promotion is stranded.
 *   - The Google `sub` is bound to the new user row at creation (takeover guard).
 */

export type SignupResult =
  | {
      readonly outcome: "provisioned";
      readonly organizationId: string;
      readonly ownerUserId: string;
      readonly session: AdminSessionPayload;
    }
  /** The email already belongs to a user (any org) → send them to login. */
  | { readonly outcome: "existing" }
  /** The org cap is reached → signups are paused. */
  | { readonly outcome: "cap_reached" }
  /** The Google `sub` is already bound to another user row (B3) → login. */
  | { readonly outcome: "google_id_taken" };

export interface ProvisionOrgWithOwnerInput {
  readonly businessName: string;
  readonly identity: VerifiedGoogleIdentity;
}

/**
 * Provision a brand-new org with the given Google identity as its super_admin
 * owner — or return a non-provisioning outcome (existing email, cap, google-id
 * clash). The returned session is ready to mint as the admin session cookie.
 */
export async function provisionOrgWithOwner(
  input: ProvisionOrgWithOwnerInput,
): Promise<SignupResult> {
  const email = normalizeEmail(input.identity.email);

  // B2: GLOBAL existing-email guard. The users email index is per-org (no global
  // unique), so we check across ALL orgs with limit(1). ANY hit → existing
  // account; provision nothing.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { outcome: "existing" };
  }

  // Create the org + settings + super_admin owner in ONE batch. ownerEmail is
  // NULL (B1). The Google sub is bound at creation (takeover guard). Slug
  // auto-suffixes on a name clash so signup never hard-fails.
  const created = await createOrgCore({
    name: input.businessName,
    createdBy: null,
    ownerEmail: null,
    ownerUser: {
      email,
      name: input.identity.name,
      googleId: input.identity.sub,
    },
  });

  if (!created.ok) {
    switch (created.error.kind) {
      case "org_limit_reached":
        return { outcome: "cap_reached" };
      case "google_id_taken":
        // Brand-new email but the Google sub is already bound to another user
        // (B3): terminal, send to login rather than 500.
        return { outcome: "google_id_taken" };
      case "email_taken":
        // RACE LOSER: the B2 pre-check above passed, but a concurrent same-email
        // signup (different Google sub) provisioned first and the GLOBAL email
        // unique index caught us. This race-loser provisioned NOTHING — surface
        // the same terminal "you already have an account" outcome so the callback
        // redirects to login, not a 500.
        return { outcome: "existing" };
      case "invalid_name":
      case "slug_conflict":
        // invalid_name is guarded by the route (businessName is validated before
        // we get here); slug_conflict can't occur on the auto-suffix path. Both
        // are programming errors here.
        throw new Error(
          `Unexpected createOrgCore error on signup path: ${created.error.kind}`,
        );
    }
  }

  const { organizationId, ownerUserId } = created.result;
  if (!ownerUserId) {
    // ownerUser was passed, so createOrgCore always returns ownerUserId — this
    // is unreachable, but the type is optional so we guard it.
    throw new Error("createOrgCore did not return an ownerUserId for signup");
  }

  return {
    outcome: "provisioned",
    organizationId,
    ownerUserId,
    session: {
      userId: ownerUserId,
      organizationId,
      email,
      name: input.identity.name ?? email,
      role: "super_admin",
    },
  };
}
