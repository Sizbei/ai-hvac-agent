/**
 * Resolve the Housecall Pro WEBHOOK signing secret for an org. (Stage 5.)
 *
 * Mirrors config.ts's API-key resolution, but for the webhook secret used to
 * verify inbound job-status events. Two sources, in order:
 *
 *   1. The per-org `webhook_secret_encrypted` column on housecall_pro_connections
 *      (AES-256-GCM at rest via @/lib/crypto), set through the admin connect flow.
 *   2. The HOUSECALL_WEBHOOK_SECRET env var — a single-tenant fallback for
 *      local/dev or a single-account deployment.
 *
 * Returns null when BOTH are absent — the signal the route uses to FAIL CLOSED
 * (reject every webhook with 401) rather than accept unverified events. The
 * decrypted secret lives only in the returned value's memory; never logged.
 * Tenant-scoped via withTenant.
 */
import { db } from "@/lib/db";
import { housecallProConnections } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";

/** The optional single-tenant env fallback secret, or null when unset/blank. */
function getEnvWebhookSecret(): string | null {
  const secret = process.env.HOUSECALL_WEBHOOK_SECRET;
  return secret && secret.trim().length > 0 ? secret : null;
}

/** Decrypt-or-null without throwing on tampered/garbage ciphertext. */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) {
    return null;
  }
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Resolve the active webhook signing secret for an org, or null when not
 * configured. Checks the per-org encrypted secret first, then the env fallback.
 * Only requires `connected` to gate the stored secret (a disconnected org's
 * stored secret is ignored), but the env fallback always applies. Never logs.
 */
export async function getOrgWebhookSecret(
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      connected: housecallProConnections.connected,
      webhookSecretEncrypted: housecallProConnections.webhookSecretEncrypted,
    })
    .from(housecallProConnections)
    .where(withTenant(housecallProConnections, organizationId));

  if (row?.connected && row.webhookSecretEncrypted) {
    const orgSecret = safeDecrypt(row.webhookSecretEncrypted);
    if (orgSecret) {
      return orgSecret;
    }
  }
  return getEnvWebhookSecret();
}
