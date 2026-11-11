export interface CacheEntry<T> {
  readonly data: T;
  readonly ts: number; // Date.now() ms
}

/**
 * How long an entry stays paintable. Every hook that seeds from this cache
 * ALSO refetches on mount, so an old entry is only ever the first paint — the
 * last rows the user saw instead of a skeleton — and is replaced as soon as the
 * fresh response lands. Entries used to be dropped at their (30–60 s) TTL,
 * which re-skeletoned every page the user had been away from for a minute.
 */
export const STALE_PAINT_MS = 30 * 60_000;

/**
 * Module-level in-memory stale-while-revalidate cache.
 * Keys are arbitrary strings. T is the caller-defined payload type.
 * `ttlMs` is the caller's freshness window; an entry stays readable for at
 * least STALE_PAINT_MS so return visits paint immediately.
 * NOT serialized — cache is empty on each serverless cold start and
 * on client module re-load (e.g. hot reload in dev). That is correct:
 * this is a navigation-bounce cache, not a persistence layer.
 */
export function createSwrCache<T>(ttlMs: number): {
  get(key: string): CacheEntry<T> | null;
  /** True while the entry is inside the caller's own freshness window. */
  isFresh(key: string): boolean;
  set(key: string, data: T): void;
  invalidate(key: string): void;
} {
  const store = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): CacheEntry<T> | null {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > Math.max(ttlMs, STALE_PAINT_MS)) {
        store.delete(key);
        return null;
      }
      return entry;
    },
    isFresh(key: string): boolean {
      const entry = store.get(key);
      return entry !== undefined && Date.now() - entry.ts <= ttlMs;
    },
    set(key: string, data: T): void {
      store.set(key, { data, ts: Date.now() });
    },
    invalidate(key: string): void {
      store.delete(key);
    },
  };
}
