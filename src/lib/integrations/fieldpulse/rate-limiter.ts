/**
 * FIELDPULSE RATE LIMITER
 *
 * Token bucket rate limiter with adaptive throttling for bulk operations.
 * Prevents API overload and handles 429 responses gracefully.
 *
 * ┌─ RATE LIMITER ───────────────────────────────────────────────────────────┐
 * │ Implements token bucket algorithm with:                                    │
 * │ - Burst capacity for handling small batches immediately                    │
 * │ - Sustained rate limit for long-running operations                         │
 * │ - Adaptive throttling based on 429 responses                              │
 * │ - Per-client rate tracking to prevent one client from starving others     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import type { RateLimitInfo } from "./bulk-types";

/**
 * Default rate limits for Fieldpulse API (conservative defaults).
 * Adjust based on actual API documentation or observed behavior.
 */
const DEFAULT_RATE_LIMITS = {
  /** Sustained requests per second */
  sustainedRps: 2,
  /** Burst capacity (can handle small spikes) */
  burstCapacity: 10,
  /** How much to reduce rate when throttled (percentage) */
  throttleReduction: 0.5,
  /** Minimum time between requests in milliseconds */
  minRequestIntervalMs: 50,
} as const;

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

  constructor(options = DEFAULT_RATE_LIMITS) {
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

    const now = Date.now();
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
 * Global rate limiter instance for Fieldpulse operations.
 * Shared across all bulk operations to maintain aggregate rate limits.
 */
export const fieldpulseRateLimiter = new RateLimiter();

/**
 * Wait function that respects rate limiter suggestions.
 * Returns the actual delay applied.
 */
export async function waitForRateLimit(
  clientId: string,
  limiter: RateLimiter = fieldpulseRateLimiter,
): Promise<number> {
  const info = limiter.checkLimit(clientId);
  const delay = info.state === "blocked"
    ? info.resetMs + 100 // Add buffer for blocked state
    : info.suggestedDelayMs;

  if (delay > 0) {
    await sleep(delay);
  }
  return delay;
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
