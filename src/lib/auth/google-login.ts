import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/admin/staff-queries";
import type { AdminSessionPayload } from "./types";
import type { VerifiedGoogleIdentity } from "./google-oidc";

/**
 * Resolve a verified Google identity to an admin session — or a denial reason.
 *
 * POLICY: pre-provisioned only. Google AUTHENTICATES; it never auto-creates an
 * account. A login succeeds only when a user row already exists for that email,
 * is active, and holds an admin-tier role (super_admin or admin). On success we
 * lazily link the row's google_id to Google's `sub` (first login), and on
 * subsequent logins require that the sub still matches — a different Google
 * account presenting the same email is rejected (account-takeover guard).
 *
 * The caller (callback route) MUST have already verified the id_token signature,
 * issuer, audience, expiry, and nonce, and confirmed email_verified === true.
 */
export type GoogleLoginResult =
  | { ok: true; session: AdminSessionPayload }
  | { ok: false; reason: "no_account" | "sub_mismatch" };

export async function resolveGoogleLogin(
  identity: VerifiedGoogleIdentity,
): Promise<GoogleLoginResult> {
  const email = normalizeEmail(identity.email);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Pre-provisioned only: no row, inactive, or non-admin-tier → denied, with a
  // single generic reason (no account enumeration).
  const isAdminTier =
    user && (user.role === "super_admin" || user.role === "admin");
  if (!user || !isAdminTier || !user.isActive) {
    return { ok: false, reason: "no_account" };
  }

  // Account-takeover guard: if this row was already linked to a Google account,
  // the presented sub must match. A different sub for the same email is refused.
  if (user.googleId !== null && user.googleId !== identity.sub) {
    return { ok: false, reason: "sub_mismatch" };
  }

  // First Google login for this user → link the sub so future logins are bound
  // to this exact Google account.
  if (user.googleId === null) {
    await db
      .update(users)
      .set({ googleId: identity.sub })
      .where(eq(users.id, user.id));
  }

  // role is narrowed to admin-tier by the isAdminTier check above.
  const role = user.role === "super_admin" ? "super_admin" : "admin";
  return {
    ok: true,
    session: {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      role,
    },
  };
}
