/**
 * STORAGE for per-org Housecall Pro connections.
 *
 * The HCP API key is encrypted at rest (AES-256-GCM via @/lib/crypto) and
 * decrypted only in memory, only when building a config for an API call. The
 * key is NEVER returned to the client or logged. Non-secret account metadata
 * (company name, account id) is cached as JSON purely for the settings panel.
 * Every query is tenant-scoped via withTenant.
 */
import { db } from "@/lib/db";
import { housecallProConnections } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import type { HousecallAccountInfo } from "./types";

/** Connection status for the admin UI — NEVER includes the API key. */
export interface HousecallConnectionStatus {
  readonly connected: boolean;
  readonly accountInfo: HousecallAccountInfo | null;
}

/** The not-connected status, reused for the no-row and disconnected cases. */
const DISCONNECTED: HousecallConnectionStatus = {
  connected: false,
  accountInfo: null,
};

/** Narrow the JSON `accountInfo` column to our type (untrusted DB jsonb). */
function toAccountInfo(raw: unknown): HousecallAccountInfo | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return {
    companyName: typeof obj.companyName === "string" ? obj.companyName : null,
    accountId: typeof obj.accountId === "string" ? obj.accountId : null,
  };
}

/**
 * Public, key-free connection status for an org. Returns DISCONNECTED when no
 * row exists, the row is disconnected, or the encrypted key is missing. Safe to
 * send to the client.
 */
export async function getHousecallConnectionStatus(
  organizationId: string,
): Promise<HousecallConnectionStatus> {
  const [row] = await db
    .select({
      connected: housecallProConnections.connected,
      apiKeyEncrypted: housecallProConnections.apiKeyEncrypted,
      accountInfo: housecallProConnections.accountInfo,
    })
    .from(housecallProConnections)
    .where(withTenant(housecallProConnections, organizationId));

  if (!row || !row.connected || !row.apiKeyEncrypted) {
    return DISCONNECTED;
  }
  return { connected: true, accountInfo: toAccountInfo(row.accountInfo) };
}

/**
 * Persist a successful connection: encrypt + store the API key, cache the
 * non-secret account info, mark connected. Upserts the single per-org row
 * (insert on first connect, overwrite on reconnect) — neon-http friendly: a
 * single statement, no transaction.
 */
export async function saveHousecallConnection(
  organizationId: string,
  params: {
    readonly apiKey: string;
    readonly accountInfo: HousecallAccountInfo;
    /**
     * Optional HCP webhook signing secret (Stage 5). Encrypted at rest like the
     * API key. When omitted, any previously stored secret is preserved on
     * reconnect (we don't clobber it with null) so re-validating the API key
     * doesn't silently disable webhook verification.
     */
    readonly webhookSecret?: string;
  },
): Promise<void> {
  const apiKeyEncrypted = encrypt(params.apiKey);
  const webhookSecretEncrypted =
    params.webhookSecret && params.webhookSecret.trim().length > 0
      ? encrypt(params.webhookSecret.trim())
      : undefined;

  await db
    .insert(housecallProConnections)
    .values({
      organizationId,
      apiKeyEncrypted,
      webhookSecretEncrypted: webhookSecretEncrypted ?? null,
      accountInfo: params.accountInfo,
      connected: true,
    })
    .onConflictDoUpdate({
      target: housecallProConnections.organizationId,
      set: {
        apiKeyEncrypted,
        accountInfo: params.accountInfo,
        connected: true,
        updatedAt: new Date(),
        // Only overwrite the stored secret when a new one was provided —
        // spreading a conditional key leaves it untouched otherwise.
        ...(webhookSecretEncrypted
          ? { webhookSecretEncrypted }
          : {}),
      },
    });
}

/**
 * Disconnect an org: clear the encrypted key + cached account info and flip
 * connected=false. Keeps the row so reconnects reuse it. No-op-safe if no row
 * exists.
 */
export async function disconnectHousecallConnection(
  organizationId: string,
): Promise<void> {
  await db
    .update(housecallProConnections)
    .set({
      connected: false,
      apiKeyEncrypted: null,
      webhookSecretEncrypted: null,
      accountInfo: null,
      updatedAt: new Date(),
    })
    .where(withTenant(housecallProConnections, organizationId));
}

/**
 * Decrypt + return the HCP API key for an org, or null when the org isn't
 * connected (no row, disconnected, or no stored key). This is the signal
 * {@link getHousecallConfig} uses to fall through to the env fallback / treat
 * the integration as not configured. The decrypted key lives only in the
 * returned value's memory; never logged.
 */
export async function getOrgHousecallApiKey(
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      connected: housecallProConnections.connected,
      apiKeyEncrypted: housecallProConnections.apiKeyEncrypted,
    })
    .from(housecallProConnections)
    .where(withTenant(housecallProConnections, organizationId));

  if (!row || !row.connected || !row.apiKeyEncrypted) {
    return null;
  }
  return decrypt(row.apiKeyEncrypted);
}
