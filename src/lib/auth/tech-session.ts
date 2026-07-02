import "server-only";

import { cookies } from "next/headers";
import { signTechToken, verifyTechToken } from "./tech-config";
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
    // "strict" blocks CSRF against the state-changing /api/tech/* endpoints
    // (status advance, location ingest). The tech UI is same-origin.
    sameSite: "strict",
    maxAge: TECH_SESSION_MAX_AGE,
    path: "/",
  });
}

export async function getTechSession(): Promise<TechSessionPayload | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(TECH_SESSION_COOKIE);
  if (!cookie?.value) {
    return null;
  }
  return verifyTechToken(cookie.value);
}

export async function deleteTechSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TECH_SESSION_COOKIE);
}
