interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes to prevent memory leak
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  const cutoff = now - windowMs;
  for (const [key, entry] of store.entries()) {
    const filtered = entry.timestamps.filter((t) => t > cutoff);
    if (filtered.length === 0) {
      store.delete(key);
    } else {
      entry.timestamps = filtered;
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export function slidingWindow(
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  cleanup(windowMs);

  const entry = store.get(key) ?? { timestamps: [] };
  const cutoff = now - windowMs;

  // Remove expired timestamps (immutable filter)
  const activeTimestamps = entry.timestamps.filter((t) => t > cutoff);

  if (activeTimestamps.length >= maxRequests) {
    const oldestInWindow = activeTimestamps[0]!;
    // Update stored timestamps without mutation of original array
    store.set(key, { timestamps: activeTimestamps });
    return {
      allowed: false,
      remaining: 0,
      resetMs: oldestInWindow + windowMs - now,
    };
  }

  // Add current request timestamp
  const updatedTimestamps = [...activeTimestamps, now];
  store.set(key, { timestamps: updatedTimestamps });

  return {
    allowed: true,
    remaining: maxRequests - updatedTimestamps.length,
    resetMs: windowMs,
  };
}

// Rate limit configs for different endpoints
export const RATE_LIMITS = {
  chat: { maxRequests: 20, windowMs: 60_000 }, // 20 messages per minute
  sessionCreate: { maxRequests: 5, windowMs: 60_000 }, // 5 sessions per minute
  sessionAction: { maxRequests: 10, windowMs: 60_000 }, // 10 actions per minute
  adminMutation: { maxRequests: 30, windowMs: 60_000 }, // 30 admin writes/deletes per minute
  // Polled admin read surfaces (dashboard overview, dispatch board) refresh on
  // a 30s timer. 60/min/user comfortably covers a few open tabs while still
  // capping a stuck/re-mounting client.
  adminRead: { maxRequests: 60, windowMs: 60_000 },
} as const;

// Reset store (for testing)
export function resetRateLimitStore(): void {
  store.clear();
}
