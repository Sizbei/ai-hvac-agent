import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "hvac_session_token";
export const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export function generateSessionToken(): string {
  return randomUUID();
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
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
