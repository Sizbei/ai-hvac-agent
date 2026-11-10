import "server-only";

import { cookies } from "next/headers";
import { after } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isDemoOrg } from "@/lib/tenancy/demo-mode";
import { flagsStatementSql } from "@/lib/admin/onboarding-sql";
import { signTechToken, verifyTechToken } from "./tech-config";
import { isSessionUserCurrent } from "./session-revocation";
import type { TechSessionPayload } from "./tech-config";

// A DISTINCT cookie from the admin session (hvac_admin_session) so the two
// sessions never alias: getTechSession reads only this cookie, getAdminSession
// only the other, and the role/audience checks reject a token in the wrong slot.
const TECH_SESSION_COOKIE = "hvac_tech_session";
const TECH_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export async function createTechSession(
  payload: TechSessionPayload,
): Promise<void> {
  const token = await signTechToken(payload);
  const cookieStore = await cookies();
  cookieStore.set(TECH_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // "lax", not "strict": the Google OIDC callback can mint this cookie
    // mid-way through a navigation chain that originates on
    // accounts.google.com, and browsers refuse to attach strict cookies to the
    // follow-up /tech/jobs request (the same trap the admin session hit). Lax
    // still withholds the cookie on cross-site POST/fetch, which is what
    // protects the state-changing /api/tech/* endpoints from CSRF.
    sameSite: "lax",
    maxAge: TECH_SESSION_MAX_AGE,
    path: "/",
  });

  // Setup guide: stamp the first technician sign-in (set-once, guarded in SQL).
  after(async () => {
    if (isDemoOrg(payload.organizationId)) return;
    try {
      await db.execute(
        flagsStatementSql({
          organizationId: payload.organizationId,
          flags: { techSignedInAt: new Date().toISOString() },
          top: {},
          guardTechSignedIn: true,
        }),
      );
    } catch (error) {
      logger.warn(
        { error, organizationId: payload.organizationId },
        "onboarding techSignedInAt write failed",
      );
    }
  });
}

export async function getTechSession(): Promise<TechSessionPayload | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(TECH_SESSION_COOKIE);
  if (!cookie?.value) {
    return null;
  }
  const payload = await verifyTechToken(cookie.value);
  if (!payload) {
    return null;
  }
  // Revocation freshness: deny a fired/deactivated technician's still-valid token.
  if (
    !(await isSessionUserCurrent(
      payload.userId,
      payload.organizationId,
      payload.role,
      payload.email,
    ))
  ) {
    return null;
  }
  return payload;
}

export async function deleteTechSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TECH_SESSION_COOKIE);
}
