/**
 * Fieldpulse configuration resolution.
 *
 * Mirrors housecall-pro/config.ts: read the org's encrypted API key from the DB,
 * decrypt it, and resolve a {@link FieldpulseConfig}. Falls back to the env
 * FIELDPULSE_API_KEY for single-tenant setups. Returns null when neither is
 * available — the single signal callers branch on to DEGRADE SAFELY.
 */

import { db } from "@/lib/db";
import { fieldpulseConnections } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/encryption";

/** Base URL for the Fieldpulse REST API (AWS API Gateway stage). */
export const FIELDPULSE_BASE_URL = "https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage";

/** Resolved Fieldpulse config for one org. */
export interface FieldpulseConfig {
  /** The organization's Fieldpulse API key (decrypted, never logged). */
  readonly apiKey: string;
  /** Base URL for the Fieldpulse API. */
  readonly baseUrl: string;
}

/**
 * Load the org's Fieldpulse config from the DB, decrypt the API key, and
 * return a {@link FieldpulseConfig}. Returns null when the org has no
 * Fieldpulse connection (no api_key_encrypted) — the single signal callers
 * branch on to DEGRADE SAFELY.
 */
export async function getFieldpulseConfig(
  organizationId: string,
  baseUrl: string = FIELDPULSE_BASE_URL,
): Promise<FieldpulseConfig | null> {
  const conn = await db
    .select({ apiKeyEncrypted: fieldpulseConnections.apiKeyEncrypted })
    .from(fieldpulseConnections)
    .where(withTenant(fieldpulseConnections, organizationId))
    .limit(1);

  let apiKey: string | null = null;
  if (conn.length > 0 && conn[0].apiKeyEncrypted) {
    apiKey = decrypt(conn[0].apiKeyEncrypted);
  }

  // Env fallback for single-tenant setups (mirrors HCP pattern).
  if (!apiKey) {
    apiKey = process.env.FIELDPULSE_API_KEY?.trim() ?? null;
  }

  if (!apiKey) {
    return null;
  }

  return { apiKey, baseUrl };
}
