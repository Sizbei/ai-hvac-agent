import "server-only";

import { cookies } from "next/headers";
import { signToken, verifyToken } from "./config";
import { isSessionUserCurrent } from "./session-revocation";
import type { AdminSessionPayload } from "./types";

const ADMIN_SESSION_COOKIE = "hvac_admin_session";
const ADMIN_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export async function createAdminSession(
  payload: AdminSessionPayload,
): Promise<void> {
  const token = await signToken(payload);
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true, // Always secure - use HTTPS in development too
    // "lax", not "strict": the Google OIDC callback sets this cookie mid-way
    // through a navigation chain that ORIGINATES on accounts.google.com, and
    // browsers refuse to attach strict cookies to the follow-up /admin request
    // — the user lands back on the login page despite a successful login.
    // Lax still withholds the cookie on cross-site POST/fetch, which is what
    // protects the state-changing /api/admin/* endpoints from CSRF.
    sameSite: "lax",
    maxAge: ADMIN_SESSION_MAX_AGE,
    path: "/",
  });
}

export async function getAdminSession(): Promise<AdminSessionPayload | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  if (!cookie?.value) {
    return null;
  }
  const payload = await verifyToken(cookie.value);
  if (!payload) {
    return null;
  }
  // Revocation freshness: deny if the user was deactivated/demoted/deleted since
  // the token was issued (a 24h JWT would otherwise keep authorizing).
  if (
    !(await isSessionUserCurrent(
      payload.userId,
      payload.organizationId,
      payload.role,
    ))
  ) {
    return null;
  }
  return payload;
}

export async function deleteAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_SESSION_COOKIE);
}
