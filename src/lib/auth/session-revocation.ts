import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Revocation freshness check for a cryptographically-valid session.
 *
 * JWT sessions are stateless and live 24h, so without this a deactivated,
 * demoted, or deleted user's existing cookie keeps authorizing every request
 * until the token expires — the admin "deactivate" action silently fails at its
 * security purpose. After the signature/claims verify, we do one indexed read of
 * the users row and require it to still exist, be active, and hold the role the
 * token claims (a demotion changes the role → old admin tokens stop authorizing
 * admin endpoints).
 *
 * Fails OPEN on a DB error (returns true) — the token is already crypto-valid and
 * a transient DB blip must not lock every operator out; it degrades to the prior
 * crypto-only behavior. DENIES on a definitive mismatch (row missing / inactive /
 * role changed).
 *
 * NOTE: does not yet revoke on password reset (the old token stays valid while
 * the user is active with the same role) — that needs a per-user token version
 * embedded at login and bumped on reset. Tracked as a follow-up.
 */
export async function isSessionUserCurrent(
  userId: string,
  organizationId: string,
  role: string,
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ isActive: users.isActive, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)))
      .limit(1);
    return !!row && row.isActive === true && row.role === role;
  } catch (error) {
    logger.error(
      { error, userId },
      "Session revocation check failed; honoring the crypto-valid session (fail-open)",
    );
    return true;
  }
}
