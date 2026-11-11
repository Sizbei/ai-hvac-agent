import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSwrCache } from './swr-cache';

describe('createSwrCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('get returns null when key missing', () => {
    const cache = createSwrCache<string>(60_000);
    const result = cache.get('missing-key');
    expect(result).toBeNull();
  });

  it('get returns the stored entry when within TTL', () => {
    const cache = createSwrCache<string>(60_000);
    cache.set('key1', 'value1');
    const result = cache.get('key1');
    expect(result).not.toBeNull();
    expect(result?.data).toBe('value1');
    expect(typeof result?.ts).toBe('number');
  });

  it('keeps an entry paintable past its TTL (stale-while-revalidate)', () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const cache = createSwrCache<string>(60_000); // 60 second freshness window
    cache.set('key1', 'value1');

    vi.setSystemTime(new Date('2026-07-10T00:05:00Z')); // 5 minutes later
    expect(cache.get('key1')?.data).toBe('value1');
  });

  it('isFresh follows the caller TTL, not the stale-paint window', () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const cache = createSwrCache<string>(60_000);
    expect(cache.isFresh('key1')).toBe(false);
    cache.set('key1', 'value1');
    expect(cache.isFresh('key1')).toBe(true);
    vi.setSystemTime(new Date('2026-07-10T00:01:01Z'));
    expect(cache.isFresh('key1')).toBe(false);
    expect(cache.get('key1')?.data).toBe('value1');
  });

  it('drops an entry once it is older than the stale-paint window', () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const cache = createSwrCache<string>(60_000);
    cache.set('key1', 'value1');

    vi.setSystemTime(new Date('2026-07-10T00:31:00Z')); // 31 minutes later
    expect(cache.get('key1')).toBeNull();
    // The entry is gone, not just hidden.
    vi.setSystemTime(new Date('2026-07-10T00:00:30Z'));
    expect(cache.get('key1')).toBeNull();
  });

  it('set overwrites a previous entry', () => {
    const cache = createSwrCache<string>(60_000);
    cache.set('key1', 'value1');
    let result = cache.get('key1');
    expect(result?.data).toBe('value1');

    cache.set('key1', 'value2');
    result = cache.get('key1');
    expect(result?.data).toBe('value2');
  });

  it('invalidate removes an entry so get returns null', () => {
    const cache = createSwrCache<string>(60_000);
    cache.set('key1', 'value1');
    let result = cache.get('key1');
    expect(result).not.toBeNull();

    cache.invalidate('key1');
    result = cache.get('key1');
    expect(result).toBeNull();
  });

  it('invalidate on a missing key is a no-op (no throw)', () => {
    const cache = createSwrCache<string>(60_000);
    expect(() => {
      cache.invalidate('missing-key');
    }).not.toThrow();
  });
});
