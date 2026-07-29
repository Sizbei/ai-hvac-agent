/**
 * Provider swap-on-fail decision test.
 *
 * This repo's vitest environment is `node` (no jsdom/RTL), so a component
 * render test isn't feasible. Per the plan, the provider's swap decision is
 * extracted into the pure `resolveActiveMap` function, and we test THAT — it
 * is exactly the branch the component's `useState(appleFailed)` drives:
 *   - configured for Apple + not-yet-failed → mount Apple
 *   - Apple reported onFail (appleFailed=true) → swap to MapLibre
 *   - never configured for Apple → always MapLibre
 */
import { describe, it, expect, vi } from 'vitest';

// The provider module imports `next/dynamic`; stub it so importing the pure
// function under test doesn't require a bundler/runtime component graph.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

import { resolveActiveMap } from './dispatch-map-provider';

describe('resolveActiveMap', () => {
  it('mounts Apple when provider is apple and it has not failed', () => {
    expect(resolveActiveMap('apple', false)).toBe('apple');
  });

  it('swaps to MapLibre when the Apple map reports a failure', () => {
    expect(resolveActiveMap('apple', true)).toBe('maplibre');
  });

  it('always renders MapLibre when the provider is maplibre', () => {
    expect(resolveActiveMap('maplibre', false)).toBe('maplibre');
    expect(resolveActiveMap('maplibre', true)).toBe('maplibre');
  });
});
