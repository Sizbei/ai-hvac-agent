export interface CacheEntry<T> {
  readonly data: T;
  readonly ts: number; // Date.now() ms
}

/**
 * Module-level in-memory cache with TTL.
 * Keys are arbitrary strings. T is the caller-defined payload type.
 * NOT serialized — cache is empty on each serverless cold start and
 * on client module re-load (e.g. hot reload in dev). That is correct:
 * this is a navigation-bounce cache, not a persistence layer.
 */
export function createSwrCache<T>(ttlMs: number): {
  get(key: string): CacheEntry<T> | null;
  set(key: string, data: T): void;
  invalidate(key: string): void;
} {
  const store = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): CacheEntry<T> | null {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > ttlMs) {
        store.delete(key);
        return null;
      }
      return entry;
    },
    set(key: string, data: T): void {
      store.set(key, { data, ts: Date.now() });
    },
    invalidate(key: string): void {
      store.delete(key);
    },
  };
}
