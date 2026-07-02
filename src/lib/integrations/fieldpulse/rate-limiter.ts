/**
 * FIELDPULSE RATE LIMITER
 *
 * The token-bucket limiter now lives in `../shared/rate-limiter` (it is shared
 * with Housecall Pro and any future integration). This module is a thin
 * re-export so existing FieldPulse imports (`bulk-operations`, the test suites)
 * keep working unchanged — and the FieldPulse rate-limiter test transitively
 * proves the shared implementation is behavior-preserving.
 */
export {
  RateLimiter,
  fieldpulseRateLimiter,
  waitForRateLimit,
  chunk,
  type RateLimiterOptions,
  type RateLimitInfo,
} from "../shared/rate-limiter";
