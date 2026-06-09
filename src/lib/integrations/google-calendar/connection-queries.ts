/**
 * STORAGE for per-org Google Calendar connections.
 *
 * The refresh token is encrypted at rest (AES-256-GCM via @/lib/crypto) and
 * decrypted only in memory, only when building tokens for an API call. Tokens
 * are NEVER returned to the client or logged. Every query is tenant-scoped via
 * withTenant.
 */
import { db } from "@/lib/db";
import { googleCalendarConnections } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import type { OrgGoogleTokens } from "./types";

/** Connection status for the admin UI — NEVER includes any token material. */
export interface GoogleConnectionStatus {
  readonly connected: boolean;
  readonly calendarId: string | null;
}

/** The not-connected status, reused for the no-row and disconnected cases. */
const DISCONNECTED: GoogleConnectionStatus = {
  connected: false,
  calendarId: null,
};

/**
 * Public, token-free connection status for an org. Returns DISCONNECTED when no
 * row exists. Safe to send to the client.
 */
export async function getGoogleConnectionStatus(
  organizationId: string,
): Promise<GoogleConnectionStatus> {
  const [row] = await db
    .select({
      connected: googleCalendarConnections.connected,
      calendarId: googleCalendarConnections.calendarId,
      refreshTokenEncrypted:
        googleCalendarConnections.refreshTokenEncrypted,
    })
    .from(googleCalendarConnections)
    .where(withTenant(googleCalendarConnections, organizationId));

  if (!row || !row.connected || !row.refreshTokenEncrypted) {
    return DISCONNECTED;
  }
  return { connected: true, calendarId: row.calendarId };
}

/**
 * Persist a successful OAuth connection: encrypt + store the refresh token,
 * cache the access token, mark connected. Upserts the single per-org row
 * (insert on first connect, overwrite on reconnect) — neon-http friendly: a
 * single statement, no transaction.
 */
export async function saveGoogleConnection(
  organizationId: string,
  params: {
    readonly refreshToken: string;
    readonly accessToken: string;
    readonly accessTokenExpiresAt: number;
    readonly calendarId: string;
  },
): Promise<void> {
  const refreshTokenEncrypted = encrypt(params.refreshToken);
  const accessTokenExpiresAt = new Date(params.accessTokenExpiresAt);

  await db
    .insert(googleCalendarConnections)
    .values({
      organizationId,
      calendarId: params.calendarId,
      refreshTokenEncrypted,
      accessToken: params.accessToken,
      accessTokenExpiresAt,
      connected: true,
    })
    .onConflictDoUpdate({
      target: googleCalendarConnections.organizationId,
      set: {
        calendarId: params.calendarId,
        refreshTokenEncrypted,
        accessToken: params.accessToken,
        accessTokenExpiresAt,
        connected: true,
        updatedAt: new Date(),
      },
    });
}

/**
 * Disconnect an org: clear token material and flip connected=false. Keeps the
 * row so reconnects reuse it. No-op-safe if no row exists.
 */
export async function disconnectGoogleConnection(
  organizationId: string,
): Promise<void> {
  await db
    .update(googleCalendarConnections)
    .set({
      connected: false,
      refreshTokenEncrypted: null,
      accessToken: null,
      accessTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(withTenant(googleCalendarConnections, organizationId));
}

/**
 * Decrypt + assemble the OAuth tokens a client needs to call Google for this
 * org. Returns null when the org isn't connected (no row, disconnected, or no
 * stored refresh token) — the signal sync callers use to NO-OP. The decrypted
 * refresh token lives only in the returned value's memory; never logged.
 */
export async function getOrgGoogleTokens(
  organizationId: string,
): Promise<OrgGoogleTokens | null> {
  const [row] = await db
    .select({
      connected: googleCalendarConnections.connected,
      calendarId: googleCalendarConnections.calendarId,
      refreshTokenEncrypted:
        googleCalendarConnections.refreshTokenEncrypted,
      accessToken: googleCalendarConnections.accessToken,
      accessTokenExpiresAt:
        googleCalendarConnections.accessTokenExpiresAt,
    })
    .from(googleCalendarConnections)
    .where(withTenant(googleCalendarConnections, organizationId));

  if (!row || !row.connected || !row.refreshTokenEncrypted) {
    return null;
  }

  return {
    refreshToken: decrypt(row.refreshTokenEncrypted),
    accessToken: row.accessToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt
      ? row.accessTokenExpiresAt.getTime()
      : null,
    calendarId: row.calendarId,
  };
}
