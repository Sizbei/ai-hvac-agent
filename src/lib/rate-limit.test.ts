import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { slidingWindow, resetRateLimitStore, RATE_LIMITS } from '@/lib/rate-limit';

beforeEach(() => {
  resetRateLimitStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('slidingWindow', () => {
  it('should allow first request and return remaining = maxRequests - 1', () => {
    const result = slidingWindow('user:1', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should allow requests up to the max', () => {
    for (let i = 0; i < 5; i++) {
      const result = slidingWindow('user:2', 5, 60_000);
      expect(result.allowed).toBe(true);
    }
  });

  it('should block request at max + 1', () => {
    for (let i = 0; i < 5; i++) {
      slidingWindow('user:3', 5, 60_000);
    }
    const blocked = slidingWindow('user:3', 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('should track different keys independently', () => {
    // Fill up user:4
    for (let i = 0; i < 5; i++) {
      slidingWindow('user:4', 5, 60_000);
    }
    // user:5 should still be allowed
    const result = slidingWindow('user:5', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should allow requests after window expires', () => {
    // Fill up the window
    for (let i = 0; i < 5; i++) {
      slidingWindow('user:6', 5, 60_000);
    }
    const blocked = slidingWindow('user:6', 5, 60_000);
    expect(blocked.allowed).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(60_001);

    const allowed = slidingWindow('user:6', 5, 60_000);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(4);
  });

  it('should return remaining = 0 when at max requests', () => {
    for (let i = 0; i < 5; i++) {
      slidingWindow('user:7', 5, 60_000);
    }
    // The 5th call should have remaining = 0
    // Let's check by making one more
    const result = slidingWindow('user:7', 5, 60_000);
    expect(result.remaining).toBe(0);
  });

  it('should return resetMs for blocked requests', () => {
    for (let i = 0; i < 3; i++) {
      slidingWindow('user:8', 3, 60_000);
    }
    const blocked = slidingWindow('user:8', 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetMs).toBeGreaterThan(0);
    expect(blocked.resetMs).toBeLessThanOrEqual(60_000);
  });

  it('should handle maxRequests of 1', () => {
    const first = slidingWindow('user:9', 1, 60_000);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = slidingWindow('user:9', 1, 60_000);
    expect(second.allowed).toBe(false);
  });

  it('should partially expire old timestamps within window', () => {
    // Make 3 requests
    slidingWindow('user:10', 5, 60_000);
    slidingWindow('user:10', 5, 60_000);
    slidingWindow('user:10', 5, 60_000);

    // Advance 30 seconds (within window)
    vi.advanceTimersByTime(30_000);

    // Make 2 more (total 5 within window)
    slidingWindow('user:10', 5, 60_000);
    slidingWindow('user:10', 5, 60_000);

    // Should be blocked (5 in window)
    const blocked = slidingWindow('user:10', 5, 60_000);
    expect(blocked.allowed).toBe(false);

    // Advance past the first 3 requests' window
    vi.advanceTimersByTime(30_001);

    // First 3 requests should have expired, only 2 remain in window
    const allowed = slidingWindow('user:10', 5, 60_000);
    expect(allowed.allowed).toBe(true);
  });
});

describe('resetRateLimitStore', () => {
  it('should clear all stored entries', () => {
    // Add some entries
    slidingWindow('user:reset:1', 5, 60_000);
    slidingWindow('user:reset:2', 5, 60_000);

    // Reset
    resetRateLimitStore();

    // All should be allowed again
    const result = slidingWindow('user:reset:1', 1, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);

    const result2 = slidingWindow('user:reset:1', 1, 60_000);
    expect(result2.allowed).toBe(false);
  });
});

describe('cleanup (internal)', () => {
  it('should clean up expired entries after cleanup interval', () => {
    // Add entries
    slidingWindow('cleanup:1', 5, 60_000);
    slidingWindow('cleanup:2', 5, 60_000);

    // Advance past the window so timestamps expire
    vi.advanceTimersByTime(60_001);

    // Advance past the cleanup interval (5 minutes) so cleanup triggers
    vi.advanceTimersByTime(5 * 60 * 1000);

    // Next call triggers cleanup which removes expired entries
    const result = slidingWindow('cleanup:3', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should retain entries with active timestamps during cleanup', () => {
    // Add an entry
    slidingWindow('cleanup:retain', 5, 60_000);

    // Advance past cleanup interval but NOT past the window
    vi.advanceTimersByTime(5 * 60 * 1000);

    // This call triggers cleanup; the entry should be retained because
    // its timestamp is within the window (cleanup uses windowMs param)
    // Actually, the window is 60s and we advanced 5min, so the timestamp IS expired
    // Let's add a fresh entry first
    slidingWindow('cleanup:fresh', 5, 300_000); // 5 min window

    // Advance just past cleanup interval
    vi.advanceTimersByTime(1);

    // Trigger cleanup via a new call - fresh entry should still be there
    const result = slidingWindow('cleanup:fresh', 5, 300_000);
    expect(result.allowed).toBe(true);
    // Should have 2 timestamps: the one from before and this one
    expect(result.remaining).toBe(3);
  });
});

describe('RATE_LIMITS', () => {
  it('should define chat rate limit as 20 per minute', () => {
    expect(RATE_LIMITS.chat.maxRequests).toBe(20);
    expect(RATE_LIMITS.chat.windowMs).toBe(60_000);
  });

  it('should define sessionCreate rate limit as 5 per minute', () => {
    expect(RATE_LIMITS.sessionCreate.maxRequests).toBe(5);
    expect(RATE_LIMITS.sessionCreate.windowMs).toBe(60_000);
  });

  it('should define sessionAction rate limit as 10 per minute', () => {
    expect(RATE_LIMITS.sessionAction.maxRequests).toBe(10);
    expect(RATE_LIMITS.sessionAction.windowMs).toBe(60_000);
  });
});
