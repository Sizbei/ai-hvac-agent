'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
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
  arRadius,
  esc,
  formatCents,
  notPlottedChipMessage,
  timeAgo,
} from './map-pins';

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

// Keyless OpenFreeMap vector basemap — Flighty-dark: near-monochrome so data
// pins and rings carry all the color.  Also acts as the permanent MapLibre
// fallback when the Apple MapKit map is unavailable.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

/** A 64-point geographic circle (degrees approximation) for the service radius. */
function circleFeature(lng: number, lat: number, radiusKm: number): GeoJSON.Feature {
  const coords: [number, number][] = [];
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

export function DispatchMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layerMode, setLayerMode] = useState<LayerMode>('jobs');

  // Detect prefers-reduced-motion once.
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  // Initial fetch.
  useEffect(() => {
    void load();
  }, []);

  // Init the map once data first arrives (so we can center on the base).
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return;
    // Lazily import the maplibre CSS so it only loads when the map mounts,
    // not on every admin route that shares the bundle.
    void import('maplibre-gl/dist/maplibre-gl.css');
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [data.base.longitude, data.base.latitude],
      zoom: 10,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('service-radius', {
        type: 'geojson',
        data: circleFeature(data.base.longitude, data.base.latitude, data.base.serviceRadiusKm),
      });
      map.addLayer({
        id: 'service-radius-fill',
        type: 'fill',
        source: 'service-radius',
        // On a dark basemap, a slightly higher opacity keeps the fill visible
        // without overpowering the underlying road grid.
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.10 },
      });
      map.addLayer({
        id: 'service-radius-line',
        type: 'line',
        source: 'service-radius',
        // Brighter line alpha so the boundary reads against dark tiles.
        paint: { 'line-color': '#60a5fa', 'line-opacity': 0.55, 'line-dasharray': [4, 3] },
      });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  // (Re)draw markers whenever data or layerMode changes and the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;

    const showJobs = layerMode === 'jobs' || layerMode === 'both';
    const showAr = layerMode === 'ar' || layerMode === 'both';

    const draw = () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      // Base marker — always shown.
      const base = new maplibregl.Marker({ element: baseMarkerEl() })
        .setLngLat([data.base.longitude, data.base.latitude])
        .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(`<strong>${esc(data.base.name)}</strong><br/>Base`))
        .addTo(map);
      markersRef.current.push(base);

      // Job pins.
      if (showJobs) {
        for (const job of data.jobs) {
          const popup = new maplibregl.Popup({ offset: 20, maxWidth: '260px' }).setHTML(jobPopupHTML(job));
          markersRef.current.push(
            new maplibregl.Marker({ element: jobMarkerEl(job), anchor: 'bottom' })
              .setLngLat([job.longitude, job.latitude])
              .setPopup(popup)
              .addTo(map),
          );
        }
      }

      // Technician pings — always shown.
      for (const tech of data.technicians) {
        const popup = new maplibregl.Popup({ offset: 14 }).setHTML(
          `<div style="font:13px var(--font-sans),system-ui"><strong>${esc(tech.name)}</strong><br/><span style="color:var(--muted-foreground)">Updated ${timeAgo(tech.capturedAt)}</span></div>`,
        );
        markersRef.current.push(
          new maplibregl.Marker({ element: techMarkerEl(prefersReducedMotion) })
            .setLngLat([tech.longitude, tech.latitude])
            .setPopup(popup)
            .addTo(map),
        );
      }

      // AR circles — translucent so overlaps stack without masking each other.
      if (showAr) {
        for (const ar of data.arCustomers) {
          const popup = new maplibregl.Popup({ offset: arRadius(ar.owingCents) + 4, maxWidth: '240px' }).setHTML(arPopupHTML(ar));
          markersRef.current.push(
            new maplibregl.Marker({ element: arMarkerEl(ar, prefersReducedMotion), anchor: 'center' })
              .setLngLat([ar.longitude, ar.latitude])
              .setPopup(popup)
              .addTo(map),
          );
        }
      }
    };

    if (map.isStyleLoaded()) draw();
    else map.once('load', draw);
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
    transition:
      'background var(--dur-hover) var(--ease-out), color var(--dur-hover) var(--ease-out)',
    lineHeight: '24px',
  };
  // The floating panels sit on --surface-raised over the dark basemap, so the
  // segmented control uses the standard admin pairing: navy fill for the active
  // segment, ghost for the rest.
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
        .maplibregl-popup-content{padding:10px 12px;border-radius:var(--radius-lg);box-shadow:var(--shadow-pop);}
        .maplibregl-popup-tip{filter:drop-shadow(0 2px 4px color-mix(in oklch, var(--foreground) 30%, transparent));}
      `}</style>
      <div ref={containerRef} className="h-full w-full" />

      {/* Summary bar — top left, over map */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-3 rounded-md border border-border-strong bg-surface-raised/95 px-3 py-2 shadow-[var(--shadow-pop)] backdrop-blur">
        <MapPin className="size-4 shrink-0 text-info-strong" />
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-foreground">Dispatch map</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{data.jobs.length}</span> request
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

      {/* Layer toggle — top right on desktop; drops below summary bar at ≤480px to avoid collision */}
      <div className="pointer-events-auto absolute right-11 top-4 z-10 flex items-center gap-1 rounded-md border border-border-strong bg-surface-raised/95 p-1 shadow-[var(--shadow-pop)] backdrop-blur max-[480px]:right-2 max-[480px]:top-16">
        <Layers className="ml-1 size-3.5 shrink-0 text-foreground-faint" />
        {(
          [
            { key: 'jobs', label: 'Requests' },
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

      {/* Status chips — stacked so they never overlap each other; bottom-10
          clears MapLibre's attribution bar in the same corner. */}
      <div className="pointer-events-none absolute bottom-10 right-4 z-10 flex flex-col items-end gap-1.5">
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
