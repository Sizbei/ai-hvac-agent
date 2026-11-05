'use client';

/**
 * AppleDispatchMap — the dispatch map rendered on Apple Maps (MapKit JS v6) in
 * the "Flighty" treatment: MutedStandard cartography + dark color scheme. It is
 * a feature-parity port of dispatch-map.tsx (MapLibre); every layer, popup,
 * toggle, chip, and the summary/legend chrome match the MapLibre reference. The
 * pin/callout DOM is built by the SHARED ./map-pins factories — never forked.
 *
 * ---------------------------------------------------------------------------
 * MapKit JS v6 API facts — confirmed against live docs 2026-07-30:
 *   • Loader (CDN):  https://cdn.apple-mapkit.com/mk/6/mapkit.core.js
 *       Confirmed by: developer.apple.com "Loading the latest version of
 *       MapKit JS" + webkit.org/blog/18027 (Discover MapKit JS 6). The `/mk/6`
 *       path pins the major version (not a patch). Modular: features load as
 *       named libraries.
 *   • Init: mapkit.init({ authorizationCallback(done) { …done(jwt) } }) — still
 *       the v6 refresh mechanism (Apple docs .../mapkit/init). We wire it to
 *       Task 1's GET /api/admin/mapkit-token (returns { success, data:{ token,
 *       expiresAt } }). authorizationCallback re-runs when a token nears expiry.
 *   • colorScheme: LOWERCASE string "dark" — mapkit.Map.ColorSchemes.Dark ===
 *       "dark" (docs .../mapkit.map.colorschemes). "Dark" silently no-ops.
 *   • mapType: mapkit.Map.MapTypes.MutedStandard === "mutedStandard"
 *       (docs .../mapkit.map.maptypes). We pass the enum with a string fallback.
 *   • Annotations: new mapkit.Annotation(coordinate, factory, options) where
 *       `factory` returns the marker DOM element (docs .../mapkit.annotation).
 *   • Callouts: per-annotation delegate `callout.calloutElementForAnnotation`
 *       returns the popup DOM (docs .../mapkit.annotationcalloutdelegate).
 *   • Clustering: annotation option `clusteringIdentifier` groups pins at low
 *       zoom (docs .../mapkit.annotation/clusteringidentifier).
 *   • Fit-to-bounds: map.showItems(annotations, { animate: true }) — NOT
 *       fitBounds/setRegion (docs .../map/2973938-showitems).
 *   • Service radius: new mapkit.CircleOverlay(coordinate, radiusMeters, opts)
 *       with style overrides (docs .../circleoverlay).
 *   • Zoom control: map option showsZoomControl: true (docs .../map options).
 *   How confirmed: WebFetch of the webkit.org v6 blog (CDN URL, libraries) +
 *   WebSearch across Apple doc pages for each enum path/string value. The
 *   migration doc + several Apple pages are JS-rendered and returned empty to
 *   WebFetch; those facts come from the WebKit blog + Apple doc search snippets.
 *   The Apple RENDER path is UNVERIFIED-LIVE (no Apple credentials yet).
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCw, MapPin, Layers } from 'lucide-react';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import {
  type Job,
  type ArCustomer,
  jobMarkerEl,
  arMarkerEl,
  techMarkerEl,
  baseMarkerEl,
  jobPopupHTML,
  arPopupHTML,
  esc,
  formatCents,
  notPlottedChipMessage,
  timeAgo,
} from './map-pins';

// MapKit JS is loaded at runtime from Apple's CDN; it attaches `mapkit` to
// window. We keep types loose (unknown-ish) since there is no bundled d.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
type MapKit = any;
declare global {
  interface Window {
    mapkit?: MapKit;
  }
}

interface Tech {
  readonly technicianId: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly capturedAt: string;
}
interface MapData {
  readonly base: { name: string; latitude: number; longitude: number; serviceRadiusKm: number };
  readonly jobs: readonly Job[];
  readonly technicians: readonly Tech[];
  readonly arCustomers: readonly ArCustomer[];
  readonly geocodeCapped: boolean;
  readonly notPlottedCount: number;
}

type LayerMode = 'jobs' | 'ar' | 'both';

/**
 * Legend swatches MIRROR the pin fills built in ./map-pins.ts. Those pin colors
 * are deliberately exempt from the token migration (they are painted onto a
 * dark basemap, not onto app surfaces), so the key has to quote them literally
 * or it stops being a key. Every other color on this component is a token.
 * Kept in step with dispatch-map.tsx by duplication, per the FieldPulse/HCP
 * house rule for the two map implementations.
 */
const JOB_PIN_LEGEND: readonly {
  readonly label: string;
  readonly fill: string;
  /** Optional outer halo, for the live-technician ping. */
  readonly halo?: string;
}[] = [
  { label: 'Base', fill: '#334155' },
  { label: 'Technician (live)', fill: '#059669', halo: '#10b981' },
  { label: 'Emergency', fill: '#dc2626' },
  { label: 'High priority', fill: '#ea580c' },
  { label: 'Standard request', fill: '#2563eb' },
  { label: 'Low priority', fill: '#0891b2' },
];

/** AR ring colors, mirroring arStyle() in ./map-pins.ts. */
const AR_PIN_LEGEND: readonly { readonly label: string; readonly ring: string }[] = [
  { label: '<30d', ring: '#d97706' },
  { label: '30–90d', ring: '#ea580c' },
  { label: '90d+', ring: '#dc2626' },
];

const MAPKIT_SRC ='https://cdn.apple-mapkit.com/mk/6/mapkit.core.js';
const READY_WATCHDOG_MS = 8000;

interface AppleDispatchMapProps {
  /** Called on any unrecoverable failure so the provider can swap to MapLibre. */
  readonly onFail: () => void;
}

/**
 * Load mapkit.core.js exactly once app-wide and initialize with our
 * token-fetching authorizationCallback. Resolves with the ready `mapkit`
 * global. Rejects on script-load error or init throw. A module-level promise
 * dedupes concurrent/subsequent mounts.
 */
let mapkitReady: Promise<MapKit> | null = null;

/**
 * Mid-session token refreshes re-run the authorizationCallback long after
 * `mapkitReady` settled — its reject() is then a no-op, which would leave a
 * dead map with no fallback. Mounted components register here so a refresh
 * failure still reaches their onFail and the provider can swap to MapLibre.
 */
const tokenFailureListeners = new Set<() => void>();

function notifyTokenFailure() {
  for (const listener of tokenFailureListeners) listener();
}

function loadMapkit(): Promise<MapKit> {
  if (mapkitReady) return mapkitReady;
  mapkitReady = new Promise<MapKit>((resolve, reject) => {
    const finishInit = () => {
      const mapkit = window.mapkit;
      if (!mapkit) {
        reject(new Error('mapkit global missing after load'));
        return;
      }
      try {
        mapkit.init({
          authorizationCallback: (done: (token: string) => void) => {
            void (async () => {
              try {
                const res = await adminFetch('/api/admin/mapkit-token');
                if (!res.ok) {
                  reject(new Error(`token fetch ${res.status}`));
                  notifyTokenFailure();
                  return;
                }
                const body = await res.json().catch(() => null);
                const token = body?.data?.token;
                if (typeof token !== 'string') {
                  reject(new Error('token missing in response'));
                  notifyTokenFailure();
                  return;
                }
                done(token);
              } catch (err) {
                if (err instanceof AdminAuthRedirectError) return;
                reject(err instanceof Error ? err : new Error('token fetch failed'));
                notifyTokenFailure();
              }
            })();
          },
        });
        resolve(mapkit);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('mapkit.init threw'));
      }
    };

    // Reuse an existing script tag if another mount already injected it.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${MAPKIT_SRC}"]`);
    if (existing) {
      if (window.mapkit) finishInit();
      else {
        existing.addEventListener('load', finishInit, { once: true });
        existing.addEventListener('error', () => reject(new Error('mapkit script load error')), { once: true });
      }
      return;
    }

    const script = document.createElement('script');
    script.src = MAPKIT_SRC;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', finishInit, { once: true });
    script.addEventListener('error', () => reject(new Error('mapkit script load error')), { once: true });
    document.head.appendChild(script);
  });
  // If init/load fails, clear the cache so a later mount can retry.
  mapkitReady.catch(() => {
    mapkitReady = null;
  });
  return mapkitReady;
}

/** Build a mapkit callout delegate that renders a fixed HTML string. */
function htmlCalloutDelegate(html: string) {
  return {
    calloutElementForAnnotation() {
      const el = document.createElement('div');
      el.className = 'apple-dm-callout';
      el.innerHTML = html; // html is built by esc()-guarded map-pins builders
      return el;
    },
  };
}

export function AppleDispatchMap({ onFail }: AppleDispatchMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapKit | null>(null);
  const mapkitRef = useRef<MapKit | null>(null);
  const readyRef = useRef(false);
  const failedRef = useRef(false);
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layerMode, setLayerMode] = useState<LayerMode>('jobs');

  // Detect prefers-reduced-motion once (snapshot — matches MapLibre semantics).
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Report an unrecoverable failure to the provider exactly once.
  const fail = () => {
    if (failedRef.current) return;
    failedRef.current = true;
    onFail();
  };

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await adminFetch('/api/admin/dispatch/map');
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setData(body.data);
        setError(null);
      } else {
        setError("Couldn't load the map data.");
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      setError("Couldn't load the map data.");
    } finally {
      setLoading(false);
    }
  }

  // Initial data fetch.
  useEffect(() => {
    void load();
  }, []);

  // A mid-session token-refresh failure (settled-promise reject is a no-op)
  // must still swap this instance out — subscribe to the module-level notifier.
  useEffect(() => {
    const onTokenFailure = () => fail();
    tokenFailureListeners.add(onTokenFailure);
    return () => {
      tokenFailureListeners.delete(onTokenFailure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load MapKit + init the map once data first arrives (center on base).
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return;
    let cancelled = false;

    // Watchdog: if no map instance is ready within 8s, fall back.
    const watchdog = window.setTimeout(() => {
      if (!readyRef.current) fail();
    }, READY_WATCHDOG_MS);

    void loadMapkit()
      .then((mapkit) => {
        if (cancelled || !containerRef.current) return;
        mapkitRef.current = mapkit;

        const mapTypes = mapkit.Map?.MapTypes ?? {};
        const colorSchemes = mapkit.Map?.ColorSchemes ?? {};
        const map = new mapkit.Map(containerRef.current, {
          mapType: mapTypes.MutedStandard ?? 'mutedStandard',
          colorScheme: colorSchemes.Dark ?? 'dark',
          showsZoomControl: true,
          showsMapTypeControl: false,
          showsCompass: mapkit.FeatureVisibility?.Hidden ?? 'hidden',
          isRotationEnabled: false,
          center: new mapkit.Coordinate(data.base.latitude, data.base.longitude),
        });
        mapRef.current = map;
        readyRef.current = true;
        window.clearTimeout(watchdog);
      })
      .catch(() => {
        window.clearTimeout(watchdog);
        fail();
      });

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      const map = mapRef.current;
      if (map) {
        try {
          map.destroy();
        } catch {
          /* map already torn down */
        }
        mapRef.current = null;
        readyRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // (Re)draw overlays + annotations whenever data or layerMode changes.
  useEffect(() => {
    const map = mapRef.current;
    const mapkit = mapkitRef.current;
    if (!map || !mapkit || !data) return;

    const showJobs = layerMode === 'jobs' || layerMode === 'both';
    const showAr = layerMode === 'ar' || layerMode === 'both';

    // Clear previous overlays + annotations.
    if (map.annotations?.length) map.removeAnnotations(map.annotations);
    if (map.overlays?.length) map.removeOverlays(map.overlays);

    const annotations: MapKit[] = [];

    // Service-radius circle — dashed ring, matching the MapLibre approximation.
    const radiusMeters = data.base.serviceRadiusKm * 1000;
    const circle = new mapkit.CircleOverlay(
      new mapkit.Coordinate(data.base.latitude, data.base.longitude),
      radiusMeters,
    );
    // Opacity rides in the rgba colors — mapkit.Style has no strokeOpacity.
    circle.style = new mapkit.Style({
      lineWidth: 1.5,
      lineColor: 'rgba(37, 99, 235, 0.35)',
      lineDash: [4, 4],
      fillColor: '#2563eb',
      fillOpacity: 0.06,
    });
    map.addOverlay(circle);

    // Base marker — always shown.
    const baseAnn = new mapkit.Annotation(
      new mapkit.Coordinate(data.base.latitude, data.base.longitude),
      () => baseMarkerEl(),
      {
        anchorOffset: new DOMPoint(0, 0),
        callout: htmlCalloutDelegate(
          `<div style="font:13px var(--font-sans),system-ui"><strong>${esc(data.base.name)}</strong><br/>Base</div>`,
        ),
      },
    );
    annotations.push(baseAnn);

    // Job pins.
    if (showJobs) {
      for (const job of data.jobs) {
        annotations.push(
          new mapkit.Annotation(
            new mapkit.Coordinate(job.latitude, job.longitude),
            () => jobMarkerEl(job),
            {
              clusteringIdentifier: 'jobs',
              anchorOffset: new DOMPoint(0, -13),
              callout: htmlCalloutDelegate(jobPopupHTML(job)),
            },
          ),
        );
      }
    }

    // Technician pings — always shown.
    for (const tech of data.technicians) {
      annotations.push(
        new mapkit.Annotation(
          new mapkit.Coordinate(tech.latitude, tech.longitude),
          () => techMarkerEl(prefersReducedMotion),
          {
            callout: htmlCalloutDelegate(
              `<div style="font:13px var(--font-sans),system-ui"><strong>${esc(tech.name)}</strong><br/><span style="color:var(--muted-foreground)">Updated ${timeAgo(tech.capturedAt)}</span></div>`,
            ),
          },
        ),
      );
    }

    // AR "money owed" circles.
    if (showAr) {
      for (const ar of data.arCustomers) {
        annotations.push(
          new mapkit.Annotation(
            new mapkit.Coordinate(ar.latitude, ar.longitude),
            () => arMarkerEl(ar, prefersReducedMotion),
            {
              callout: htmlCalloutDelegate(arPopupHTML(ar)),
            },
          ),
        );
      }
    }

    map.addAnnotations(annotations);

    // Fit-to-bounds on data load via showItems (never fitBounds/setRegion).
    if (annotations.length > 0) {
      map.showItems(annotations, { animate: !prefersReducedMotion });
    }
  }, [data, layerMode, prefersReducedMotion]);

  // Derived summary stats.
  const unassignedCount = data?.jobs.filter((j) => !j.technicianName).length ?? 0;
  const totalOwingCents = data?.arCustomers.reduce((s, a) => s + a.owingCents, 0) ?? 0;
  const arOnMap = showArLayer(layerMode) ? (data?.arCustomers.length ?? 0) : 0;
  const notPlottedMsg = data
    ? notPlottedChipMessage(data.notPlottedCount, data.geocodeCapped)
    : null;

  const layerBtnBase: React.CSSProperties = {
    height: 26,
    padding: '0 12px',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 'var(--radius-md)',
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'background var(--dur-hover) var(--ease-out), color var(--dur-hover) var(--ease-out)',
    lineHeight: '24px',
  };
  // Matches the MapLibre reference exactly: navy fill for the active segment,
  // ghost for the rest, on the --surface-raised floating panel.
  const layerBtnActive: React.CSSProperties = {
    ...layerBtnBase,
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    borderColor: 'var(--primary)',
  };
  const layerBtnInactive: React.CSSProperties = {
    ...layerBtnBase,
    background: 'transparent',
    color: 'var(--muted-foreground)',
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border-strong bg-surface">
      <style>{`
        @keyframes dm-ping{75%,100%{transform:scale(2.2);opacity:0}}
        .apple-dm-callout{padding:10px 12px;border-radius:var(--radius-lg);background:var(--surface-raised);box-shadow:var(--shadow-pop);}
      `}</style>
      <div ref={containerRef} className="h-full w-full" />

      {/* Summary bar — top left, over map */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-3 rounded-md border border-border-strong bg-surface-raised/95 px-3 py-2 shadow-[var(--shadow-pop)] backdrop-blur">
        <MapPin className="size-4 shrink-0 text-info-strong" />
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-foreground">Dispatch map</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{data.jobs.length}</span> job
              {data.jobs.length !== 1 ? 's' : ''}
              {unassignedCount > 0 && (
                <span className="ml-1 font-medium text-warning-strong">
                  <span className="font-mono tabular-nums">{unassignedCount}</span> unassigned
                </span>
              )}
              {' · '}
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatCents(totalOwingCents)}
              </span>
              {' owed on map'}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="pointer-events-auto ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          aria-label="Refresh map"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Layer toggle — top right on desktop; drops below summary bar at ≤480px */}
      <div className="pointer-events-auto absolute right-11 top-4 z-10 flex items-center gap-1 rounded-md border border-border-strong bg-surface-raised/95 p-1 shadow-[var(--shadow-pop)] backdrop-blur max-[480px]:right-2 max-[480px]:top-16">
        <Layers className="ml-1 size-3.5 shrink-0 text-foreground-faint" />
        {(
          [
            { key: 'jobs', label: 'Jobs' },
            { key: 'ar', label: 'Money owed' },
            { key: 'both', label: 'Both' },
          ] as { key: LayerMode; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            style={layerMode === key ? layerBtnActive : layerBtnInactive}
            onClick={() => setLayerMode(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 rounded-md border border-border-strong bg-surface-raised/95 px-3 py-2 text-xs shadow-[var(--shadow-pop)] backdrop-blur">
        <p className="mb-1.5 font-semibold text-foreground">Legend</p>
        <ul className="space-y-1.5">
          {JOB_PIN_LEGEND.map(({ label, fill, halo }) => (
            <li key={label} className="flex items-center gap-2 text-muted-foreground">
              <span
                className="inline-block size-3 shrink-0 rounded-[2px]"
                style={{
                  background: fill,
                  boxShadow: halo ? `0 0 0 2px ${halo}4d` : undefined,
                }}
              />{' '}
              {label}
            </li>
          ))}
          <li className="pt-1 font-medium text-muted-foreground">Money owed</li>
          {AR_PIN_LEGEND.map(({ label, ring }) => (
            <li key={label} className="flex items-center gap-2 text-muted-foreground">
              <span
                className="inline-block size-3 shrink-0 rounded-[2px] border-2"
                style={{ borderColor: ring, background: `${ring}33` }}
              />{' '}
              {label}
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="absolute inset-x-0 top-1/2 z-10 mx-auto w-fit -translate-y-1/2 rounded-md border border-danger-border bg-surface-raised px-4 py-2 text-[13px] text-danger-strong shadow-[var(--shadow-pop)]">
          {error}
        </div>
      )}

      {/* Status chips — stacked so they never overlap each other */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10 flex flex-col items-end gap-1.5">
        {notPlottedMsg && (
          <div className="rounded-[3px] border border-border bg-surface-raised/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-[var(--shadow-pop)] backdrop-blur">
            {notPlottedMsg}
          </div>
        )}
        {data && showArLayer(layerMode) && arOnMap === 0 && data.arCustomers.length === 0 && (
          <div className="rounded-[3px] border border-border bg-surface-raised/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-[var(--shadow-pop)] backdrop-blur">
            No geocoded AR customers
          </div>
        )}
      </div>
    </div>
  );
}

function showArLayer(mode: LayerMode): boolean {
  return mode === 'ar' || mode === 'both';
}
