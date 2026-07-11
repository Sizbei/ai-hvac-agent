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
 *
 * PERF: a passing check is cached in-memory for 30s per warm lambda instance,
 * because this read runs SERIALLY before every authed response (it gates
 * getAdminSession) and would otherwise add a DB round trip to every API call.
 * Only POSITIVE results are cached — a deny always re-checks — so the worst
 * case is a deactivation taking up to 30s (per instance) to bite, against a
 * token that is otherwise valid for hours.
 */
const REVOCATION_CACHE_TTL_MS = 30_000;
const revocationCache = new Map<string, number>(); // key → ts of last PASS

/** Test hook: reset the pass-cache so cases don't leak into each other. */
export function clearRevocationCacheForTests(): void {
  revocationCache.clear();
}

export async function isSessionUserCurrent(
  userId: string,
  organizationId: string,
  role: string,
): Promise<boolean> {
  const cacheKey = `${userId}:${organizationId}:${role}`;
  const cachedAt = revocationCache.get(cacheKey);
  if (cachedAt !== undefined && Date.now() - cachedAt < REVOCATION_CACHE_TTL_MS) {
    return true;
  }
  try {
    const [row] = await db
      .select({ isActive: users.isActive, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)))
      .limit(1);
    const ok = !!row && row.isActive === true && row.role === role;
    if (ok) {
      revocationCache.set(cacheKey, Date.now());
    } else {
      revocationCache.delete(cacheKey);
    }
    return ok;
  } catch (error) {
    logger.error(
      { error, userId },
      "Session revocation check failed; honoring the crypto-valid session (fail-open)",
    );
    return true;
  }
}
