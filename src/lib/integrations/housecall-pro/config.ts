/**
 * Housecall Pro configuration resolution.
 *
 * Unlike Google's app-level OAuth client, an HCP connection is a single API key
 * scoped to ONE org's HCP account. {@link getHousecallConfig} resolves that key
 * for an org from two sources, in order:
 *
 *   1. The per-org connection row (encrypted at rest via @/lib/crypto), set
 *      through the admin connect flow. This is the production path.
 *   2. The HOUSECALL_API_KEY env var — an optional single-tenant fallback for
 *      local/dev or a single-account deployment.
 *
 * When neither is present the integration DEGRADES SAFELY: this returns null and
 * callers ({@link getHousecallClient}) surface a clear "not configured" path
 * rather than attempting a broken request. The API key is NEVER logged.
 */
import { getOrgHousecallApiKey } from "./connection-queries";

const HOUSECALL_API_BASE = "https://api.housecallpro.com";

export interface HousecallConfig {
  /** The resolved HCP API key (plaintext in memory only; never logged). */
  readonly apiKey: string;
  /** REST base URL — overridable for testing, defaults to production. */
  readonly baseUrl: string;
}

/** The optional single-tenant env fallback key, or null when unset/blank. */
function getEnvApiKey(): string | null {
  const key = process.env.HOUSECALL_API_KEY;
  return key && key.trim().length > 0 ? key : null;
}

/**
 * Resolve the active HCP config for an org, or null when not configured.
 *
 * Checks the per-org encrypted connection first, then the env fallback. Returns
 * null (=> not configured, degrade safely) only when BOTH are absent. The base
 * URL is fixed to production; an injected value is used only by tests.
 */
export async function getHousecallConfig(
  organizationId: string,
  baseUrl: string = HOUSECALL_API_BASE,
): Promise<HousecallConfig | null> {
  const orgKey = await getOrgHousecallApiKey(organizationId);
  const apiKey = orgKey ?? getEnvApiKey();
  if (!apiKey) {
    return null;
  }
  return { apiKey, baseUrl };
}
