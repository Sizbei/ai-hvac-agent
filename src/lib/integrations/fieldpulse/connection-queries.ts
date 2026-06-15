/**
 * STORAGE for per-org Fieldpulse connections.
 *
 * The Fieldpulse API key is encrypted at rest (AES-256-GCM) and decrypted only
 * in memory, only when building a config for an API call. The key is NEVER
 * returned to the client or logged. Non-secret account metadata (company name,
 * account id) is cached as JSON purely for the settings panel.
 */
import { db } from "@/lib/db";
import { fieldpulseConnections } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt } from "@/lib/crypto";
import type { FieldpulseAccountInfo } from "./types";

/** Connection status for the admin UI — NEVER includes the API key. */
export interface FieldpulseConnectionStatus {
  readonly connected: boolean;
  readonly accountInfo: FieldpulseAccountInfo | null;
}

/** The not-connected status, reused for the no-row and disconnected cases. */
const DISCONNECTED: FieldpulseConnectionStatus = {
  connected: false,
  accountInfo: null,
};

/** Narrow the JSON `accountInfo` column to our type (untrusted DB jsonb). */
function toAccountInfo(raw: unknown): FieldpulseAccountInfo | null {
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
export async function getFieldpulseConnectionStatus(
  organizationId: string,
): Promise<FieldpulseConnectionStatus> {
  const [row] = await db
    .select({
      connected: fieldpulseConnections.connected,
      apiKeyEncrypted: fieldpulseConnections.apiKeyEncrypted,
      accountInfo: fieldpulseConnections.accountInfo,
    })
    .from(fieldpulseConnections)
    .where(withTenant(fieldpulseConnections, organizationId));

  if (!row || !row.connected || !row.apiKeyEncrypted) {
    return DISCONNECTED;
  }
  return { connected: true, accountInfo: toAccountInfo(row.accountInfo) };
}

/** Input to save a Fieldpulse connection (after successful validation). */
export interface SaveFieldpulseConnectionInput {
  readonly apiKey: string;
  readonly accountInfo: FieldpulseAccountInfo;
  readonly webhookSecret?: string;
}

/**
 * Save a Fieldpulse connection: encrypt the API key (and optional webhook
 * secret), cache the non-secret account metadata, and mark connected=true.
 * Upserts on organizationId so re-connect updates the existing row.
 */
export async function saveFieldpulseConnection(
  organizationId: string,
  input: SaveFieldpulseConnectionInput,
): Promise<void> {
  const apiKeyEncrypted = encrypt(input.apiKey);
  const webhookSecretEncrypted =
    input.webhookSecret && input.webhookSecret.trim().length > 0
      ? encrypt(input.webhookSecret.trim())
      : undefined;

  await db
    .insert(fieldpulseConnections)
    .values({
      organizationId,
      apiKeyEncrypted,
      webhookSecretEncrypted: webhookSecretEncrypted ?? null,
      accountInfo: input.accountInfo,
      connected: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: fieldpulseConnections.organizationId,
      set: {
        apiKeyEncrypted,
        accountInfo: input.accountInfo,
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
export async function deleteFieldpulseConnection(
  organizationId: string,
): Promise<void> {
  await db
    .update(fieldpulseConnections)
    .set({
      connected: false,
      apiKeyEncrypted: null,
      webhookSecretEncrypted: null,
      accountInfo: null,
      updatedAt: new Date(),
    })
    .where(withTenant(fieldpulseConnections, organizationId));
}
