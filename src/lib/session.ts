import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "hvac_session_token";
export const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export function generateSessionToken(): string {
  return randomUUID();
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === "production";
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    // The customer chat runs inside a cross-site <iframe> on contractors'
    // sites. A SameSite=Strict/Lax cookie is NOT sent on the cross-site fetch
    // subrequests the iframe makes to /api/*, so the session would fail to
    // authenticate after creation. SameSite=None (which REQUIRES Secure) lets
    // the cookie travel in that embedded context. In dev (http) we fall back to
    // Lax since None+insecure is rejected by browsers. The cookie is still
    // httpOnly, so the host page can't read it.
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  });
}

export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  return cookie?.value ?? null;
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
