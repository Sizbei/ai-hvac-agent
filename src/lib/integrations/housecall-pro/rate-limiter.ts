/**
 * HOUSECALL PRO RATE LIMITER
 *
 * HCP's binding to the shared token-bucket limiter (`../shared/rate-limiter`).
 * The per-request retry inside the HCP client already handles 429/5xx; this
 * limiter sits at the BATCH/consumer layer (mirroring how FieldPulse's
 * bulk-operations consumes its limiter), so it does NOT wrap `client.request()`
 * — that would double-handle 429 against the client's own backoff.
 *
 * Use `withHcpRateLimit(orgId, fn)` to rate-limit a unit of HCP work: it waits
 * for a token before running `fn`, reports success, and on a 429-ish error
 * reports the throttle (so subsequent calls back off) before rethrowing.
 */
import {
  housecallRateLimiter,
  waitForRateLimit,
} from "../shared/rate-limiter";

export { housecallRateLimiter } from "../shared/rate-limiter";

/** True when an error looks like an HCP 429 (rate limited). */
function isThrottleError(error: unknown): boolean {
  return /\b429\b|too many requests|rate limit/i.test(String(error));
}

/**
 * Run an HCP API unit of work under the shared rate limiter, keyed by org.
 * Waits for a token (adaptive backoff when throttled), reports success on
 * completion, and reports a throttle on a 429-ish error before rethrowing.
 */
export async function withHcpRateLimit<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await waitForRateLimit(organizationId, housecallRateLimiter);
  try {
    const result = await fn();
    housecallRateLimiter.reportSuccess(organizationId);
    return result;
  } catch (error: unknown) {
    if (isThrottleError(error)) {
      housecallRateLimiter.reportThrottle(organizationId);
    }
    throw error;
  }
}
