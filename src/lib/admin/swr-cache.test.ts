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

  it('get returns null (and removes the entry) when TTL has expired', () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const cache = createSwrCache<string>(60_000); // 60 second TTL
    cache.set('key1', 'value1');

    // Move time forward past TTL
    vi.setSystemTime(new Date('2026-07-10T00:01:01Z')); // 61 seconds later
    const result = cache.get('key1');
    expect(result).toBeNull();

    // Verify entry was deleted
    const secondCheck = cache.get('key1');
    expect(secondCheck).toBeNull();
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
