'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { MapProvider } from '@/app/admin/(dashboard)/map/page-client';

/**
 * DispatchMapProvider — picks exactly ONE map implementation and renders only
 * that chunk. When `mapProvider === "apple"` it renders the Apple MapKit map;
 * if that map reports a failure (token fetch non-2xx, script load error,
 * mapkit.init throw, or the 8s readiness watchdog) it swaps to the MapLibre
 * map via state so the operator never sees a blank pane.
 *
 * Invariant: never render both maps and never CSS-hide one. Only the ACTIVE
 * branch's dynamic import is instantiated, so only its chunk loads.
 */

/** Shared loading placeholder for either lazily-imported map. */
function MapLoading() {
  return (
    <div
      className="flex h-full min-h-[400px] animate-pulse items-center justify-center rounded-xl border bg-muted text-sm text-muted-foreground"
      aria-label="Loading map"
      role="status"
    >
      <span aria-hidden="true">Loading map…</span>
    </div>
  );
}

// MapLibre needs `window`, so never render it on the server.
const DispatchMap = dynamic(
  () => import('./dispatch-map').then((m) => m.DispatchMap),
  { ssr: false, loading: () => <MapLoading /> },
);

// Apple MapKit map — also client-only (loads mapkit.core.js at runtime).
const AppleDispatchMap = dynamic(
  () => import('./apple-dispatch-map').then((m) => m.AppleDispatchMap),
  { ssr: false, loading: () => <MapLoading /> },
);

/**
 * Which concrete map to mount, given the server-resolved provider and whether
 * the Apple map has reported a runtime failure. Pure so it can be unit-tested
 * without a DOM (this repo's vitest env is `node`, no jsdom/RTL).
 */
export function resolveActiveMap(
  mapProvider: MapProvider,
  appleFailed: boolean,
): 'apple' | 'maplibre' {
  if (mapProvider === 'apple' && !appleFailed) return 'apple';
  return 'maplibre';
}

interface DispatchMapProviderProps {
  readonly mapProvider: MapProvider;
}

export function DispatchMapProvider({ mapProvider }: DispatchMapProviderProps) {
  const [appleFailed, setAppleFailed] = useState(false);
  const active = resolveActiveMap(mapProvider, appleFailed);

  if (active === 'apple') {
    return <AppleDispatchMap onFail={() => setAppleFailed(true)} />;
  }
  return <DispatchMap />;
}
