import "server-only";

import { sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { db } from "@/lib/db";
import { errorCode, logger } from "@/lib/logger";
import { isDemoOrg } from "@/lib/tenancy/demo-mode";
import { flagsStatementSql } from "@/lib/admin/onboarding-sql";
import { signTechToken, verifyTechToken } from "./tech-config";
import { isSessionUserCurrent } from "./session-revocation";
import { getAdminSession } from "./session";
import { isPlatformAdmin } from "./authz";
import { PREVIEW_COOKIE, verifyPreviewCookie } from "./preview-cookie";
import type { TechSessionPayload } from "./tech-config";

/**
 * A technician session. `preview` is set only for the platform owner's
 * read-only "View as": the real admin (rate limits stay theirs) and the
 * cookie's expiry (the banner reloads then).
 */
export type TechSession = TechSessionPayload & {
  readonly preview?: { readonly adminUserId: string; readonly exp: number };
};

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

export async function getTechSession(): Promise<TechSession | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(TECH_SESSION_COOKIE);
  if (!cookie?.value) {
    return previewTechSession(cookieStore.get(PREVIEW_COOKIE)?.value);
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

/**
 * "View as" a technician (spec P7 stretch). Only with NO technician cookie: a
 * platform admin's session, a preview cookie that verifies and is bound to that
 * session, and a target that is an active technician of the session's org. The
 * proxy refuses every non-GET while such a cookie is valid and bound, and
 * `preview` tells GET handlers not to write. Anything else → null.
 */
async function previewTechSession(previewCookie: string | undefined): Promise<TechSession | null> {
  if (!previewCookie) return null;
  const claims = await verifyPreviewCookie(previewCookie, process.env.AUTH_SECRET ?? "");
  if (!claims) return null;
  const admin = await getAdminSession();
  if (!admin || !isPlatformAdmin(admin) || claims.adminUserId !== admin.userId) return null;
  try {
    const res = await db.execute(sql`SELECT id, name, email, role FROM users
      WHERE id = ${claims.targetUserId} AND organization_id = ${admin.organizationId} AND is_active = true
      LIMIT 1`);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.role !== "technician") return null;
    return {
      userId: String(row.id),
      organizationId: admin.organizationId,
      email: String(row.email),
      name: String(row.name),
      role: "technician",
      preview: { adminUserId: admin.userId, exp: claims.exp },
    };
  } catch (error) {
    logger.error(
      { code: errorCode(error), organizationId: admin.organizationId },
      "Technician preview lookup failed; no technician session",
    );
    return null;
  }
}

export async function deleteTechSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TECH_SESSION_COOKIE);
}
