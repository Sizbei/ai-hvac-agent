/**
 * Tests for the Housecall Pro rate-limiter binding (withHcpRateLimit).
 *
 * The token-bucket itself is covered by the shared/FieldPulse suite; here we
 * verify the consumer-side glue: success reports success, a 429-ish failure
 * reports a throttle (then rethrows), a non-429 failure does NOT throttle, and
 * the limiter is keyed per org.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { withHcpRateLimit, housecallRateLimiter } from "./rate-limiter";

beforeEach(() => {
  // Fresh, full buckets so waitForRateLimit returns immediately (no real sleep).
  housecallRateLimiter.resetAll();
  vi.restoreAllMocks();
});

describe("withHcpRateLimit", () => {
  it("returns the result and reports success on the happy path", async () => {
    const success = vi.spyOn(housecallRateLimiter, "reportSuccess");
    const throttle = vi.spyOn(housecallRateLimiter, "reportThrottle");

    const result = await withHcpRateLimit("org-1", async () => "ok");

    expect(result).toBe("ok");
    expect(success).toHaveBeenCalledWith("org-1");
    expect(throttle).not.toHaveBeenCalled();
  });

  it("reports a throttle and rethrows on a 429-ish error", async () => {
    const throttle = vi.spyOn(housecallRateLimiter, "reportThrottle");
    const success = vi.spyOn(housecallRateLimiter, "reportSuccess");

    await expect(
      withHcpRateLimit("org-1", async () => {
        throw new Error("HCP request failed: 429 Too Many Requests");
      }),
    ).rejects.toThrow(/429/);

    expect(throttle).toHaveBeenCalledWith("org-1");
    expect(success).not.toHaveBeenCalled();
  });

  it("does NOT throttle on a non-429 error (still rethrows)", async () => {
    const throttle = vi.spyOn(housecallRateLimiter, "reportThrottle");

    await expect(
      withHcpRateLimit("org-1", async () => {
        throw new Error("HCP request failed: 500 Internal Server Error");
      }),
    ).rejects.toThrow(/500/);

    expect(throttle).not.toHaveBeenCalled();
  });

  it("keys the limiter per org (a throttle on one org does not affect another)", async () => {
    const throttle = vi.spyOn(housecallRateLimiter, "reportThrottle");

    await withHcpRateLimit("org-A", async () => "a");
    await expect(
      withHcpRateLimit("org-B", async () => {
        throw new Error("429");
      }),
    ).rejects.toThrow();

    expect(throttle).toHaveBeenCalledTimes(1);
    expect(throttle).toHaveBeenCalledWith("org-B");
    // org-A's adaptive rate is untouched (full), org-B's is reduced.
    expect(housecallRateLimiter.getAdaptiveRate("org-A")).toBeGreaterThan(
      housecallRateLimiter.getAdaptiveRate("org-B"),
    );
  });
});
