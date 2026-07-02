'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { RefreshCw, MapPin } from 'lucide-react';

interface Job {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly urgency: string;
  readonly issueType: string;
  readonly technicianName: string | null;
  readonly arrivalWindowStart: string | null;
  readonly latitude: number;
  readonly longitude: number;
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
  readonly geocodeCapped: boolean;
}

// Keyless OpenFreeMap vector basemap — clean/light so colored markers pop.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// Urgency → marker color. Emergencies shout; routine work is calm.
function jobColor(urgency: string): string {
  if (urgency === 'emergency') return '#dc2626'; // red-600
  if (urgency === 'high') return '#ea580c'; // orange-600
  if (urgency === 'low') return '#0891b2'; // cyan-600
  return '#2563eb'; // blue-600 (standard)
}

function humanize(s: string): string {
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

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

function jobMarkerEl(job: Job): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = `width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${jobColor(
    job.urgency,
  )};box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid #fff;cursor:pointer;`;
  const dot = document.createElement('div');
  dot.style.cssText =
    'width:8px;height:8px;border-radius:50%;background:#fff;position:absolute;top:7px;left:7px;';
  el.appendChild(dot);
  return el;
}

function techMarkerEl(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:18px;height:18px;cursor:pointer;';
  wrap.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:#10b981;opacity:.35;animation:dm-ping 1.6s cubic-bezier(0,0,.2,1) infinite;"></span>
    <span style="position:absolute;inset:4px;border-radius:50%;background:#059669;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);"></span>`;
  return wrap;
}

function baseMarkerEl(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'width:30px;height:30px;border-radius:8px;background:#0f172a;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);border:2px solid #fff;';
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  return el;
}

export function DispatchMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/dispatch/map');
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setData(body.data);
        setError(null);
      } else {
        setError("Couldn't load the map data.");
      }
    } catch {
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
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'service-radius-line',
        type: 'line',
        source: 'service-radius',
        paint: { 'line-color': '#2563eb', 'line-opacity': 0.25, 'line-dasharray': [2, 2] },
      });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  // (Re)draw markers whenever data changes and the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;

    const draw = () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      const base = new maplibregl.Marker({ element: baseMarkerEl() })
        .setLngLat([data.base.longitude, data.base.latitude])
        .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(`<strong>${data.base.name}</strong><br/>Base`))
        .addTo(map);
      markersRef.current.push(base);

      for (const job of data.jobs) {
        const win = job.arrivalWindowStart
          ? new Date(job.arrivalWindowStart).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : 'Unscheduled';
        const popup = new maplibregl.Popup({ offset: 20 }).setHTML(
          `<div style="font:13px system-ui;min-width:160px">
             <div style="font-weight:600;font-family:ui-monospace,monospace">${job.referenceNumber}</div>
             <div style="margin-top:2px">${humanize(job.issueType)} · ${humanize(job.urgency)}</div>
             <div style="color:#64748b">${humanize(job.status)}</div>
             <div style="color:#64748b">${job.technicianName ? job.technicianName : 'Unassigned'} · ${win}</div>
           </div>`,
        );
        markersRef.current.push(
          new maplibregl.Marker({ element: jobMarkerEl(job), anchor: 'bottom' })
            .setLngLat([job.longitude, job.latitude])
            .setPopup(popup)
            .addTo(map),
        );
      }

      for (const tech of data.technicians) {
        const popup = new maplibregl.Popup({ offset: 14 }).setHTML(
          `<div style="font:13px system-ui"><strong>${tech.name}</strong><br/><span style="color:#64748b">Updated ${timeAgo(tech.capturedAt)}</span></div>`,
        );
        markersRef.current.push(
          new maplibregl.Marker({ element: techMarkerEl() })
            .setLngLat([tech.longitude, tech.latitude])
            .setPopup(popup)
            .addTo(map),
        );
      }
    };

    if (map.isStyleLoaded()) draw();
    else map.once('load', draw);
  }, [data]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border bg-card shadow-sm">
      <style>{`@keyframes dm-ping{75%,100%{transform:scale(2.2);opacity:0}}`}</style>
      <div ref={containerRef} className="h-full w-full" />

      {/* Header chip */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2 rounded-lg border bg-background/90 px-3 py-2 shadow-sm backdrop-blur">
        <MapPin className="size-4 text-blue-600" />
        <div className="leading-tight">
          <p className="text-sm font-semibold">Dispatch map</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.jobs.length} jobs · {data.technicians.length} techs live
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="pointer-events-auto ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          aria-label="Refresh map"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 rounded-lg border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
        <p className="mb-1.5 font-medium">Legend</p>
        <ul className="space-y-1">
          <li className="flex items-center gap-2"><span className="inline-block size-3 rounded bg-slate-900" /> Base</li>
          <li className="flex items-center gap-2"><span className="inline-block size-3 rounded-full bg-emerald-600 ring-2 ring-emerald-600/30" /> Technician (live)</li>
          <li className="flex items-center gap-2"><span className="inline-block size-3 rounded-full bg-red-600" /> Emergency job</li>
          <li className="flex items-center gap-2"><span className="inline-block size-3 rounded-full bg-blue-600" /> Standard job</li>
        </ul>
      </div>

      {error && (
        <div className="absolute inset-x-0 top-1/2 z-10 mx-auto w-fit -translate-y-1/2 rounded-md border border-destructive/40 bg-background px-4 py-2 text-sm text-destructive shadow">
          {error}
        </div>
      )}
      {data?.geocodeCapped && (
        <div className="absolute bottom-4 right-4 z-10 rounded-md border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          Showing the nearest 25 jobs
        </div>
      )}
    </div>
  );
}
