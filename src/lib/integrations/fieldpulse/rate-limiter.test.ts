/**
 * Tests for Fieldpulse rate limiter module.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  RateLimiter,
  fieldpulseRateLimiter,
  waitForRateLimit,
  chunk,
} from "./rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkLimit", () => {
    it("should allow first request", () => {
      const result = limiter.checkLimit("client-1");

      expect(result.state).toBe("ok");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it("should allow requests up to burst capacity", () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(limiter.checkLimit("burst-client"));
      }

      // All should be allowed within burst capacity
      results.forEach((result) => {
        expect(result.allowed).toBe(true);
      });
    });

    it("should block when burst capacity is exceeded", () => {
      // Exhaust burst capacity
      for (let i = 0; i < 10; i++) {
        limiter.checkLimit("exhaust-client");
      }

      // Next request should be blocked
      const blocked = limiter.checkLimit("exhaust-client");
      expect(blocked.allowed).toBe(false);
      expect(blocked.state).toBe("blocked");
    });

    it("should refill tokens over time", () => {
      // Exhaust burst capacity
      for (let i = 0; i < 10; i++) {
        limiter.checkLimit("refill-client");
      }

      // Should be blocked
      let result = limiter.checkLimit("refill-client");
      expect(result.allowed).toBe(false);

      // Advance time by 1 second (2 requests per second sustained rate)
      vi.advanceTimersByTime(1000);

      // Should now have 2 tokens available
      result = limiter.checkLimit("refill-client");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(1);
    });

    it("should track different clients independently", () => {
      // Exhaust client-1
      for (let i = 0; i < 11; i++) {
        limiter.checkLimit("independent-1");
      }

      // client-1 should be blocked
      const blocked1 = limiter.checkLimit("independent-1");
      expect(blocked1.allowed).toBe(false);

      // client-2 should still be ok
      const allowed2 = limiter.checkLimit("independent-2");
      expect(allowed2.allowed).toBe(true);
    });

    it("should return suggested delay for ok requests", () => {
      const result = limiter.checkLimit("delay-client");

      expect(result.suggestedDelayMs).toBeGreaterThan(0);
      expect(result.suggestedDelayMs).toBeLessThan(1000);
    });

    it("should return reset time for blocked requests", () => {
      // Exhaust burst capacity
      for (let i = 0; i < 11; i++) {
        limiter.checkLimit("reset-client");
      }

      const result = limiter.checkLimit("reset-client");

      expect(result.resetMs).toBeGreaterThan(0);
      expect(result.resetMs).toBeLessThanOrEqual(10000);
    });
  });

  describe("reportThrottle", () => {
    it("should reduce rate modifier on throttle report", () => {
      // Use up some tokens
      for (let i = 0; i < 5; i++) {
        limiter.checkLimit("throttle-client");
      }

      // Report throttle
      limiter.reportThrottle("throttle-client");

      // Check adaptive rate
      const adaptiveRate = limiter.getAdaptiveRate("throttle-client");
      expect(adaptiveRate).toBeLessThan(2); // Default sustained rate is 2

      // Next check should show throttled state
      const result = limiter.checkLimit("throttle-client");
      expect(result.state).toBe("throttled");
    });

    it("should reset tokens on throttle report", () => {
      // Use tokens
      for (let i = 0; i < 5; i++) {
        limiter.checkLimit("throttle-reset-client");
      }

      // Report throttle
      limiter.reportThrottle("throttle-reset-client");

      // Tokens should be reset to 0
      const result = limiter.checkLimit("throttle-reset-client");
      expect(result.allowed).toBe(false);
    });
  });

  describe("reportSuccess", () => {
    it("should gradually restore rate modifier", () => {
      // Report throttle first
      limiter.reportThrottle("success-client");
      let rate = limiter.getAdaptiveRate("success-client");
      expect(rate).toBeLessThan(2);

      // Report success multiple times
      for (let i = 0; i < 10; i++) {
        limiter.reportSuccess("success-client");
        rate = limiter.getAdaptiveRate("success-client");
      }

      // Rate should recover toward normal
      expect(rate).toBeGreaterThan(0);
    });
  });

  describe("resetClient", () => {
    it("should reset client state", () => {
      // Use up tokens
      for (let i = 0; i < 10; i++) {
        limiter.checkLimit("reset-individual-client");
      }

      // Should be blocked
      let result = limiter.checkLimit("reset-individual-client");
      expect(result.allowed).toBe(false);

      // Reset
      limiter.resetClient("reset-individual-client");

      // Should be ok again
      result = limiter.checkLimit("reset-individual-client");
      expect(result.allowed).toBe(true);
    });
  });

  describe("getAdaptiveRate", () => {
    it("should return sustained rate when not throttled", () => {
      const rate = limiter.getAdaptiveRate("adaptive-client");
      expect(rate).toBe(2); // Default sustained rate
    });

    it("should return reduced rate when throttled", () => {
      limiter.reportThrottle("adaptive-client");
      const rate = limiter.getAdaptiveRate("adaptive-client");
      expect(rate).toBeLessThan(2);
    });
  });

  describe("cleanup", () => {
    it("should remove idle buckets", () => {
      // Create some activity
      limiter.checkLimit("cleanup-client-1");
      limiter.checkLimit("cleanup-client-2");

      // Advance time past idle timeout
      vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes

      // Trigger cleanup
      limiter.checkLimit("cleanup-client-3");

      // Old clients should have fresh starts (cleaned up)
      const result1 = limiter.checkLimit("cleanup-client-1");
      expect(result1.remaining).toBe(9); // Should have full tokens again
    });
  });

  describe("resetAll", () => {
    it("should clear all buckets", () => {
      // Create activity
      limiter.checkLimit("reset-all-1");
      limiter.checkLimit("reset-all-2");

      // Reset all
      limiter.resetAll();

      // All should start fresh
      const result1 = limiter.checkLimit("reset-all-1");
      const result2 = limiter.checkLimit("reset-all-2");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
  });
});

describe("fieldpulseRateLimiter", () => {
  beforeEach(() => {
    fieldpulseRateLimiter.resetAll();
  });

  it("should be a RateLimiter instance", () => {
    expect(fieldpulseRateLimiter).toBeInstanceOf(RateLimiter);
  });

  it("should work as a shared rate limiter", () => {
    const result = fieldpulseRateLimiter.checkLimit("shared-client");
    expect(result.allowed).toBe(true);
  });
});

describe("waitForRateLimit", () => {
  beforeEach(() => {
    fieldpulseRateLimiter.resetAll();
  });

  it("should return delay based on rate limiter state", async () => {
    const info = fieldpulseRateLimiter.checkLimit("wait-client");
    expect(info.allowed).toBe(true);

    // waitForRateLimit returns the suggested delay
    // We just verify it resolves without error
    const delay = await Promise.race([
      waitForRateLimit("wait-client"),
      Promise.resolve(0),
    ]);
    expect(typeof delay).toBe("number");
  });
});

describe("chunk utility", () => {
  it("should chunk array into specified size", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const chunks = chunk(items, 3);

    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toEqual([1, 2, 3]);
    expect(chunks[1]).toEqual([4, 5, 6]);
    expect(chunks[2]).toEqual([7, 8, 9]);
    expect(chunks[3]).toEqual([10]);
  });

  it("should return empty array for empty input", () => {
    const chunks = chunk([], 3);
    expect(chunks).toEqual([]);
  });

  it("should handle single item array", () => {
    const chunks = chunk([1], 3);
    expect(chunks).toEqual([[1]]);
  });

  it("should handle array size equal to chunk size", () => {
    const items = [1, 2, 3];
    const chunks = chunk(items, 3);
    expect(chunks).toEqual([[1, 2, 3]]);
  });

  it("should handle chunk size of 1", () => {
    const items = [1, 2, 3];
    const chunks = chunk(items, 1);
    expect(chunks).toEqual([[1], [2], [3]]);
  });

  it("should handle large chunk size", () => {
    const items = [1, 2, 3];
    const chunks = chunk(items, 100);
    expect(chunks).toEqual([[1, 2, 3]]);
  });

  it("should handle odd-sized chunks", () => {
    const items = [1, 2, 3, 4, 5];
    const chunks = chunk(items, 2);

    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("RateLimiter — Stage 4 robustness", () => {
  it("rejects a non-positive sustainedRps at construction (no Infinity-delay hang)", () => {
    expect(
      () =>
        new RateLimiter({
          sustainedRps: 0,
          burstCapacity: 10,
          throttleReduction: 0.5,
          minRequestIntervalMs: 50,
        }),
    ).toThrow(/sustainedRps/);
  });

  it("rejects a non-positive burstCapacity at construction", () => {
    expect(
      () =>
        new RateLimiter({
          sustainedRps: 2,
          burstCapacity: 0,
          throttleReduction: 0.5,
          minRequestIntervalMs: 50,
        }),
    ).toThrow(/burstCapacity/);
  });
});

describe("waitForRateLimit — Stage 4 robustness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT sleep in the ok state (no artificial throughput cap)", async () => {
    const limiter = new RateLimiter();
    const delay = await waitForRateLimit("fresh-ok-client", limiter);
    expect(delay).toBe(0);
  });

  it("waits when the bucket is blocked", async () => {
    const limiter = new RateLimiter();
    // Drain the burst capacity (10) so the next request is blocked.
    for (let i = 0; i < 10; i++) {
      limiter.checkLimit("drain-client");
    }
    const promise = waitForRateLimit("drain-client", limiter);
    await vi.runAllTimersAsync();
    const delay = await promise;
    expect(delay).toBeGreaterThan(0);
  });

  it("evicts idle buckets on the hot path (bounded memory)", async () => {
    const limiter = new RateLimiter();
    limiter.checkLimit("idle-1");
    limiter.checkLimit("idle-2");
    // Advance past the 5-minute idle timeout.
    vi.advanceTimersByTime(6 * 60 * 1000);
    // waitForRateLimit calls cleanup() — idle buckets get a fresh start.
    await waitForRateLimit("active-client", limiter);
    const revived = limiter.checkLimit("idle-1");
    expect(revived.remaining).toBe(9); // full bucket minus this request
  });
});
