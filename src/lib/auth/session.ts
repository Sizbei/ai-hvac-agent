import "server-only";

import { cookies } from "next/headers";
import { signToken, verifyToken } from "./config";
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
    // "strict" so the admin session cookie is never sent on cross-site
    // requests — this blocks CSRF against the state-changing /api/admin/*
    // endpoints (assign, delete, create). The admin UI is same-origin, so
    // strict has no UX cost here.
    sameSite: "strict",
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
  return verifyToken(cookie.value);
}

export async function deleteAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_SESSION_COOKIE);
}
