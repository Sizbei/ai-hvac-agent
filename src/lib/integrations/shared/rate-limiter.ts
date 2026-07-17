/**
 * SHARED INTEGRATION RATE LIMITER
 *
 * Token bucket rate limiter with adaptive throttling for outbound integration
 * API calls (FieldPulse, Housecall Pro, …). Prevents API overload and handles
 * 429 responses gracefully. Integration-agnostic: callers create or reuse a
 * per-API singleton and key buckets by `clientId` (an org id), so one tenant
 * can't starve another.
 *
 * ┌─ RATE LIMITER ───────────────────────────────────────────────────────────┐
 * │ Token bucket algorithm with:                                               │
 * │ - Burst capacity for handling small batches immediately                    │
 * │ - Sustained rate limit for long-running operations                         │
 * │ - Adaptive throttling based on 429 responses                              │
 * │ - Per-client rate tracking to prevent one client from starving others     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * NOTE: `RateLimitInfo` is intentionally defined here (not imported from a
 * specific integration's bulk-types) so the dependency arrow stays one-way
 * (integrations → shared, never shared → an integration).
 */

/** Rate-limit state returned by {@link RateLimiter.checkLimit}. */
export interface RateLimitInfo {
  /** Whether the request is allowed within the rate limit */
  readonly allowed: boolean;
  /** Current rate limit state */
  readonly state: "ok" | "throttled" | "blocked";
  /** Number of requests remaining in current window */
  readonly remaining: number;
  /** Time until rate limit resets (milliseconds) */
  readonly resetMs: number;
  /** Suggested delay before next request (milliseconds) */
  readonly suggestedDelayMs: number;
}

/** Tunable rate-limiter options (all values are arbitrary numbers, validated
 *  at construction). */
export interface RateLimiterOptions {
  readonly sustainedRps: number;
  readonly burstCapacity: number;
  readonly throttleReduction: number;
  readonly minRequestIntervalMs: number;
}

const DEFAULT_RATE_LIMITS: RateLimiterOptions = {
  /** Sustained requests per second */
  sustainedRps: 2,
  /** Burst capacity (can handle small spikes) */
  burstCapacity: 10,
  /** How much to reduce rate when throttled (percentage) */
  throttleReduction: 0.5,
  /** Minimum time between requests in milliseconds */
  minRequestIntervalMs: 50,
};

/**
 * Token bucket state for a single client.
 */
interface TokenBucket {
  /** Current number of available tokens */
  tokens: number;
  /** Last refill timestamp */
  lastRefill: number;
  /** Adaptive rate modifier (1.0 = normal, <1.0 = throttled) */
  rateModifier: number;
}

/**
 * Rate limiter using token bucket algorithm with adaptive throttling.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly sustainedRps: number;
  private readonly burstCapacity: number;
  private readonly throttleReduction: number;
  private readonly minRequestIntervalMs: number;

  constructor(options: RateLimiterOptions = DEFAULT_RATE_LIMITS) {
    // Guard against degenerate config that would divide by zero in checkLimit
    // (Infinity delay -> setTimeout(Infinity) hangs waitForRateLimit forever).
    if (options.sustainedRps <= 0) {
      throw new Error("RateLimiter: sustainedRps must be > 0");
    }
    if (options.burstCapacity <= 0) {
      throw new Error("RateLimiter: burstCapacity must be > 0");
    }
    this.sustainedRps = options.sustainedRps;
    this.burstCapacity = options.burstCapacity;
    this.throttleReduction = options.throttleReduction;
    this.minRequestIntervalMs = options.minRequestIntervalMs;
  }

  /**
   * Refill tokens for a bucket based on elapsed time.
   */
  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000; // seconds
    bucket.lastRefill = now;

    // Calculate new tokens based on sustained rate and adaptive modifier
    const newTokens = elapsed * this.sustainedRps * bucket.rateModifier;
    bucket.tokens = Math.min(
      this.burstCapacity,
      bucket.tokens + newTokens
    );
  }

  /**
   * Get or create a token bucket for a client.
   */
  private getBucket(clientId: string): TokenBucket {
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = {
        tokens: this.burstCapacity,
        lastRefill: Date.now(),
        rateModifier: 1.0,
      };
      this.buckets.set(clientId, bucket);
    }
    return bucket;
  }

  /**
   * Check if a request is allowed and consume a token if so.
   * Returns rate limit info for the client.
   */
  public checkLimit(clientId: string): RateLimitInfo {
    const bucket = this.getBucket(clientId);
    this.refill(bucket);

    const allowed = bucket.tokens >= 1;

    if (allowed) {
      bucket.tokens -= 1;
    }

    // Calculate time until full refill
    const timeToFullRefill = bucket.tokens >= this.burstCapacity
      ? 0
      : ((this.burstCapacity - bucket.tokens) / (this.sustainedRps * bucket.rateModifier)) * 1000;

    // Suggested delay based on current state
    const suggestedDelayMs = allowed
      ? Math.max(this.minRequestIntervalMs, 1000 / (this.sustainedRps * bucket.rateModifier))
      : timeToFullRefill;

    // Determine state
    const state = bucket.rateModifier < 1.0
      ? "throttled"
      : allowed
        ? "ok"
        : "blocked";

    return {
      allowed,
      state,
      remaining: Math.floor(bucket.tokens),
      resetMs: Math.ceil(timeToFullRefill),
      suggestedDelayMs: Math.ceil(suggestedDelayMs),
    };
  }

  /**
   * Signal that a request was rate-limited (429 response).
   * Reduces the rate modifier to back off adaptively.
   */
  public reportThrottle(clientId: string): void {
    const bucket = this.getBucket(clientId);
    bucket.rateModifier = Math.max(
      0.25, // Minimum 25% of normal rate
      bucket.rateModifier * this.throttleReduction
    );
    // Reset tokens to prevent immediate burst after throttle
    bucket.tokens = 0;
  }

  /**
   * Signal that a request succeeded.
   * Gradually restores the rate modifier to normal.
   */
  public reportSuccess(clientId: string): void {
    const bucket = this.getBucket(clientId);
    if (bucket.rateModifier < 1.0) {
      // Gradually recover (10% of the gap)
      bucket.rateModifier = Math.min(
        1.0,
        bucket.rateModifier + 0.1 * (1.0 - bucket.rateModifier)
      );
    }
  }

  /**
   * Reset a client's rate limiter state (e.g., after a long pause).
   */
  public resetClient(clientId: string): void {
    this.buckets.delete(clientId);
  }

  /**
   * Get the current adaptive rate for a client (for monitoring).
   */
  public getAdaptiveRate(clientId: string): number {
    const bucket = this.getBucket(clientId);
    return this.sustainedRps * bucket.rateModifier;
  }

  /**
   * Clean up idle buckets to prevent memory leaks.
   * Removes buckets that haven't been used in the specified duration.
   */
  public cleanup(idleTimeoutMs: number = 5 * 60 * 1000): void {
    const now = Date.now();
    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > idleTimeoutMs) {
        this.buckets.delete(clientId);
      }
    }
  }

  /**
   * Reset all buckets (for testing).
   */
  public resetAll(): void {
    this.buckets.clear();
  }
}

/**
 * Global rate limiter for FieldPulse operations. Shared across all FieldPulse
 * bulk operations to maintain aggregate rate limits.
 */
export const fieldpulseRateLimiter = new RateLimiter();

/**
 * Global rate limiter for Housecall Pro operations. A SEPARATE bucket set from
 * FieldPulse — the two APIs have independent rate budgets.
 */
export const housecallRateLimiter = new RateLimiter();

// Backstop against an unbounded wait loop. Refill is always positive
// (sustainedRps > 0, rateModifier floor 0.25), so a blocked caller acquires a
// token within a couple of iterations in practice; this cap only guards a
// pathological clock/config from hanging the loop forever.
const MAX_WAIT_ATTEMPTS = 64;

/**
 * Wait until the caller may proceed, CONSUMING one token before returning.
 * Returns the total delay applied.
 *
 * checkLimit only decrements a token when it returns `allowed`. The old code
 * checked ONCE and, when blocked, merely slept and returned — without ever
 * acquiring a token. A burst of blocked workers therefore all slept for the
 * same refill window, woke together, and stampeded past the limit (each made
 * its request having consumed nothing). Looping until `allowed` fixes that:
 * exactly one token is consumed per call, so concurrent blocked callers
 * serialize as tokens refill.
 */
export async function waitForRateLimit(
  clientId: string,
  limiter: RateLimiter = fieldpulseRateLimiter,
): Promise<number> {
  // Evict idle buckets on the hot path so the per-client map can't grow
  // unbounded within a long-lived warm instance (cleanup() is otherwise never
  // called). Cheap: bucket count ~= number of active orgs.
  limiter.cleanup();

  let totalDelay = 0;
  for (let attempt = 0; attempt < MAX_WAIT_ATTEMPTS; attempt++) {
    const info = limiter.checkLimit(clientId);

    if (info.allowed) {
      // Token acquired. In the "ok" state we do NOT impose the nominal 1000/rps
      // spacing (which was ~500ms/request at defaults and made bulk operations
      // dozens of times slower than intended) — the bucket already enforces the
      // sustained rate. In the "throttled" state (after a 429 backoff) honor the
      // suggested spacing so we ease off the upstream.
      if (info.state === "throttled" && info.suggestedDelayMs > 0) {
        await sleep(info.suggestedDelayMs);
        totalDelay += info.suggestedDelayMs;
      }
      return totalDelay;
    }

    // Blocked: no token was consumed. Wait for a refill, then re-check and try
    // to acquire again rather than proceeding token-less.
    const delay = info.resetMs + 100; // buffer past the refill
    await sleep(delay);
    totalDelay += delay;
  }

  // Backstop hit (should be unreachable): proceed rather than hang.
  return totalDelay;
}

/**
 * Chunk an array into smaller batches for controlled processing.
 */
export function chunk<T>(
  items: readonly T[],
  chunkSize: number,
): readonly T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

/**
 * Sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
