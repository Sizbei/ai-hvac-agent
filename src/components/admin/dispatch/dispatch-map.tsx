'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { RefreshCw, MapPin, Layers } from 'lucide-react';

interface Job {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly urgency: string;
  readonly issueType: string;
  readonly technicianName: string | null;
  readonly arrivalWindowStart: string | null;
  readonly customerName: string | null;
  readonly priceCents: number | null;
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
interface ArCustomer {
  readonly customerId: string;
  readonly name: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly owingCents: number;
  readonly invoiceCount: number;
  readonly oldestDays: number;
}
interface MapData {
  readonly base: { name: string; latitude: number; longitude: number; serviceRadiusKm: number };
  readonly jobs: readonly Job[];
  readonly technicians: readonly Tech[];
  readonly arCustomers: readonly ArCustomer[];
  readonly geocodeCapped: boolean;
}

type LayerMode = 'jobs' | 'ar' | 'both';

// Keyless OpenFreeMap vector basemap — clean/light so colored markers pop.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// Urgency → marker color. Emergencies shout; routine work is calm.
function jobColor(urgency: string): string {
  if (urgency === 'emergency') return '#dc2626'; // red-600
  if (urgency === 'high') return '#ea580c'; // orange-600
  if (urgency === 'low') return '#0891b2'; // cyan-600
  return '#2563eb'; // blue-600 (standard)
}

// AR age → color band. Older = redder = more urgent to collect.
function arColor(oldestDays: number): { fill: string; ring: string } {
  if (oldestDays > 90) return { fill: 'rgba(220,38,38,0.22)', ring: '#dc2626' }; // red
  if (oldestDays > 30) return { fill: 'rgba(234,88,12,0.22)', ring: '#ea580c' }; // orange
  return { fill: 'rgba(217,119,6,0.22)', ring: '#d97706' }; // amber
}

// AR balance → circle radius (10–34px, sqrt-scaled so big balances stand out).
function arRadius(owingCents: number): number {
  const dollars = owingCents / 100;
  const scaled = Math.sqrt(Math.max(dollars, 0) / 100); // $10k → sqrt(100) = 10
  return Math.min(34, Math.max(10, Math.round(scaled * 3.4)));
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

/** Format ISO arrival window start → "Fri 8–10am" style (assumes 2-hour windows). */
function formatWindow(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unscheduled';
  const tz = 'America/New_York';
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  const startH = Number(d.toLocaleTimeString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }));
  const endH = (startH + 2) % 24;
  const fmt = (h: number) => {
    const h24 = ((h % 24) + 24) % 24;
    const suffix = h24 >= 12 ? 'pm' : 'am';
    const display = h24 > 12 ? h24 - 12 : h24 === 0 ? 12 : h24;
    return `${display}${suffix}`;
  };
  const crossMidnight = endH < startH;
  return `${day} ${fmt(startH)}–${fmt(endH)}${crossMidnight ? ' (+1d)' : ''}`;
}

/** Integer cents → "$1,234.56" */
function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
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

function arMarkerEl(ar: ArCustomer, prefersReducedMotion: boolean): HTMLElement {
  const r = arRadius(ar.owingCents);
  const { fill, ring } = arColor(ar.oldestDays);
  const sz = r * 2;
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;width:${sz}px;height:${sz}px;cursor:pointer;`;
  wrap.innerHTML = `<div style="position:absolute;inset:0;border-radius:50%;background:${fill};border:2.5px solid ${ring};box-shadow:0 2px 8px rgba(0,0,0,.18);${prefersReducedMotion ? '' : 'transition:transform .15s ease;'}" onmouseenter="this.style.transform='scale(1.12)'" onmouseleave="this.style.transform=''"></div>`;
  return wrap;
}

function techMarkerEl(prefersReducedMotion: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:18px;height:18px;cursor:pointer;';
  const ping = prefersReducedMotion ? '' : `animation:dm-ping 1.6s cubic-bezier(0,0,.2,1) infinite;`;
  wrap.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:#10b981;opacity:.35;${ping}"></span>
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

/** Escape user/FieldPulse-controlled text before it goes into a popup's
 * setHTML — a customer named `<img onerror>` would otherwise execute. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

function jobPopupHTML(job: Job): string {
  const win = formatWindow(job.arrivalWindowStart);
  const techLabel = job.technicianName
    ? `<span style="color:#0f172a">${esc(job.technicianName)}</span>`
    : `<span style="color:#d97706;font-weight:600">Unassigned</span>`;
  const priceRow = job.priceCents != null
    ? `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #e2e8f0;font-weight:600;color:#0f172a">${formatCents(job.priceCents)}</div>`
    : '';
  return `<div style="font:13px/1.45 system-ui,-apple-system;min-width:180px;max-width:240px">
  <div style="font-weight:700;font-size:14px;color:#0f172a">${esc(job.customerName ?? job.referenceNumber)}</div>
  <div style="font-family:ui-monospace,monospace;font-size:11px;color:#64748b;margin-top:1px">${esc(job.referenceNumber)}</div>
  <div style="margin-top:6px;color:#334155">${esc(humanize(job.issueType))}</div>
  <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
    <span style="background:${jobColor(job.urgency)}1a;color:${jobColor(job.urgency)};border:1px solid ${jobColor(job.urgency)}40;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600">${esc(humanize(job.urgency))}</span>
    <span style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;font-size:11px">${esc(humanize(job.status))}</span>
  </div>
  <div style="margin-top:6px;color:#475569;font-size:12px">${win}</div>
  <div style="margin-top:2px;font-size:12px">${techLabel}</div>
  ${priceRow}
</div>`;
}

function arPopupHTML(ar: ArCustomer): string {
  const { ring } = arColor(ar.oldestDays);
  const ageLabel = ar.oldestDays < 30 ? `${ar.oldestDays}d` : ar.oldestDays < 90 ? `${ar.oldestDays}d` : `${ar.oldestDays}d — overdue`;
  return `<div style="font:13px/1.45 system-ui,-apple-system;min-width:160px;max-width:220px">
  <div style="font-weight:700;font-size:14px;color:#0f172a">${esc(ar.name ?? 'Unknown customer')}</div>
  <div style="margin-top:6px;font-size:20px;font-weight:700;color:${ring}">${formatCents(ar.owingCents)}</div>
  <div style="color:#64748b;font-size:12px;margin-top:2px">${ar.invoiceCount} invoice${ar.invoiceCount !== 1 ? 's' : ''} · oldest ${ageLabel}</div>
</div>`;
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
          `<div style="font:13px system-ui"><strong>${esc(tech.name)}</strong><br/><span style="color:#64748b">Updated ${timeAgo(tech.capturedAt)}</span></div>`,
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

  const layerBtnBase: React.CSSProperties = {
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #cbd5e1',
    cursor: 'pointer',
    transition: 'background .12s,color .12s',
    lineHeight: 1.4,
  };
  const layerBtnActive: React.CSSProperties = {
    ...layerBtnBase,
    background: '#0f172a',
    color: '#fff',
    borderColor: '#0f172a',
  };
  const layerBtnInactive: React.CSSProperties = {
    ...layerBtnBase,
    background: '#fff',
    color: '#475569',
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border bg-card shadow-sm">
      <style>{`
        @keyframes dm-ping{75%,100%{transform:scale(2.2);opacity:0}}
        .maplibregl-popup-content{padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);}
      `}</style>
      <div ref={containerRef} className="h-full w-full" />

      {/* Summary bar — top left, over map */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-3 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur">
        <MapPin className="size-4 shrink-0 text-blue-600" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-foreground">Dispatch map</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.jobs.length} job{data.jobs.length !== 1 ? 's' : ''}
              {unassignedCount > 0 && (
                <span className="ml-1 font-medium text-amber-600">{unassignedCount} unassigned</span>
              )}
              {' · '}
              <span className="font-medium text-foreground">{formatCents(totalOwingCents)}</span>
              {' owed on map'}
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

      {/* Layer toggle — top right (below navigation control which MapLibre adds at ~top:10) */}
      <div className="pointer-events-auto absolute right-11 top-4 z-10 flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur">
        <Layers className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
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
      <div className="absolute bottom-4 left-4 z-10 rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
        <p className="mb-1.5 font-semibold text-foreground">Legend</p>
        <ul className="space-y-1.5">
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded bg-slate-900" /> Base</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full bg-emerald-600 ring-2 ring-emerald-600/30" /> Technician (live)</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full bg-red-600" /> Emergency</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full bg-orange-600" /> High priority</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full bg-blue-600" /> Standard job</li>
          <li className="pt-1 text-muted-foreground font-medium">Money owed</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full border-2 border-amber-600 bg-amber-600/20" /> &lt;30d</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full border-2 border-orange-600 bg-orange-600/20" /> 30–90d</li>
          <li className="flex items-center gap-2 text-muted-foreground"><span className="inline-block size-3 shrink-0 rounded-full border-2 border-red-600 bg-red-600/20" /> 90d+</li>
        </ul>
      </div>

      {error && (
        <div className="absolute inset-x-0 top-1/2 z-10 mx-auto w-fit -translate-y-1/2 rounded-md border border-destructive/40 bg-background px-4 py-2 text-sm text-destructive shadow">
          {error}
        </div>
      )}

      {/* Status chips — stacked so they never overlap each other */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10 flex flex-col items-end gap-1.5">
        {data?.geocodeCapped && (
          <div className="rounded-md border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            Showing first 25 geocoded jobs
          </div>
        )}
        {data && showArLayer(layerMode) && arOnMap === 0 && data.arCustomers.length === 0 && (
          <div className="rounded-md border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
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
