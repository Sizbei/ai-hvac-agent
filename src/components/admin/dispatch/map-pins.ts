/**
 * Shared pin/popup builders for the dispatch map.
 *
 * Pure DOM-element factories and HTML-string builders — no maplibre or
 * MapKit-specific code lives here. Both the MapLibre map and the forthcoming
 * Apple MapKit map import from this module so the visual output stays in sync.
 */

import { issueTypeLabel } from '@/lib/admin/request-labels';
import { customerNameLabel } from '@/lib/admin/customer-name-display';

// ---------------------------------------------------------------------------
// Shared data types used by the builders
// ---------------------------------------------------------------------------

export interface Job {
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

export interface ArCustomer {
  readonly customerId: string;
  readonly name: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly owingCents: number;
  readonly invoiceCount: number;
  readonly oldestDays: number;
}

// ---------------------------------------------------------------------------
// Color / size helpers
// ---------------------------------------------------------------------------

/** Urgency → marker color. Emergencies shout; routine work is calm. */
export function jobColor(urgency: string): string {
  if (urgency === 'emergency') return '#dc2626'; // red-600
  if (urgency === 'high') return '#ea580c'; // orange-600
  if (urgency === 'low') return '#0891b2'; // cyan-600
  return '#2563eb'; // blue-600 (standard)
}

/** AR age → color band. Older = redder = more urgent to collect. */
export function arColor(oldestDays: number): { fill: string; ring: string } {
  if (oldestDays > 90) return { fill: 'rgba(220,38,38,0.22)', ring: '#dc2626' }; // red
  if (oldestDays > 30) return { fill: 'rgba(234,88,12,0.22)', ring: '#ea580c' }; // orange
  return { fill: 'rgba(217,119,6,0.22)', ring: '#d97706' }; // amber
}

/** AR balance → circle radius (10–34px, sqrt-scaled so big balances stand out). */
export function arRadius(owingCents: number): number {
  const dollars = owingCents / 100;
  const scaled = Math.sqrt(Math.max(dollars, 0) / 100); // $10k → sqrt(100) = 10
  return Math.min(34, Math.max(10, Math.round(scaled * 3.4)));
}

// ---------------------------------------------------------------------------
// Small string formatters
// ---------------------------------------------------------------------------

export function humanize(s: string): string {
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

/** Format ISO arrival window start → "Fri 8–10am" style (assumes 2-hour windows). */
export function formatWindow(iso: string | null): string {
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

/** Chip copy for requests that exist but couldn't be plotted (missing/failed
 * coordinates) — distinct wording for "some dropped, under the live-geocode
 * cap" vs. "some dropped, cap exceeded" so the operator knows why. Returns
 * `null` when nothing was dropped (no chip). */
export function notPlottedChipMessage(
  notPlottedCount: number,
  geocodeCapped: boolean,
): string | null {
  if (notPlottedCount <= 0) return null;
  const noun = notPlottedCount === 1 ? 'request' : 'requests';
  if (geocodeCapped) {
    return `${notPlottedCount} ${noun} couldn't be placed on the map (25-request geocoding limit reached)`;
  }
  return `${notPlottedCount} ${noun} couldn't be placed on the map`;
}

/** Integer cents → "$1,234.56" */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Escape user/FieldPulse-controlled text before it goes into a popup's
 * setHTML — a customer named `<img onerror>` would otherwise execute. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

// ---------------------------------------------------------------------------
// DOM element builders
// ---------------------------------------------------------------------------

export function jobMarkerEl(job: Job): HTMLElement {
  const el = document.createElement('div');
  // Replaced the dark drop-shadow (invisible on a dark basemap) with a soft
  // white outer ring via box-shadow.  Reads cleanly on both OpenFreeMap dark
  // and Apple MapKit MutedStandard dark; the white border + ring also provides
  // sufficient separation on lighter basemaps.
  el.style.cssText = `width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${jobColor(
    job.urgency,
  )};box-shadow:0 0 0 2px rgba(255,255,255,0.6),0 2px 8px rgba(0,0,0,.5);border:2px solid #fff;cursor:pointer;`;
  const dot = document.createElement('div');
  dot.style.cssText =
    'width:8px;height:8px;border-radius:50%;background:#fff;position:absolute;top:7px;left:7px;';
  el.appendChild(dot);
  return el;
}

export function arMarkerEl(ar: ArCustomer, prefersReducedMotion: boolean): HTMLElement {
  const r = arRadius(ar.owingCents);
  const { fill, ring } = arColor(ar.oldestDays);
  const sz = r * 2;
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;width:${sz}px;height:${sz}px;cursor:pointer;`;
  // Use a color-matched glow (ring color at 30% alpha) so AR circles lift off
  // the dark basemap.  The glow also looks intentional on Apple MapKit dark.
  wrap.innerHTML = `<div style="position:absolute;inset:0;border-radius:50%;background:${fill};border:2.5px solid ${ring};box-shadow:0 0 0 1.5px rgba(255,255,255,0.12),0 2px 12px ${ring}4d;${prefersReducedMotion ? '' : 'transition:transform .15s ease;'}" onmouseenter="this.style.transform='scale(1.12)'" onmouseleave="this.style.transform=''"></div>`;
  return wrap;
}

export function techMarkerEl(prefersReducedMotion: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:18px;height:18px;cursor:pointer;';
  const ping = prefersReducedMotion ? '' : `animation:dm-ping 1.6s cubic-bezier(0,0,.2,1) infinite;`;
  // Boosted ping ring opacity to .50 and added a green glow on the inner dot
  // so the tech marker registers immediately on a dark basemap.
  wrap.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:#10b981;opacity:.50;${ping}"></span>
    <span style="position:absolute;inset:4px;border-radius:50%;background:#059669;border:2px solid #fff;box-shadow:0 0 6px rgba(16,185,129,0.7),0 1px 4px rgba(0,0,0,.4);"></span>`;
  return wrap;
}

export function baseMarkerEl(): HTMLElement {
  const el = document.createElement('div');
  // Slate-600 fill (#475569) with a white 2px border and a light outer ring
  // gives the HQ marker pop on both dark (MapLibre/OpenFreeMap) and Apple
  // MapKit's dark MutedStandard basemap.  Pure #0f172a was near-invisible
  // against dark tiles.
  el.style.cssText =
    'width:30px;height:30px;border-radius:8px;background:#334155;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2.5px rgba(255,255,255,0.25),0 2px 10px rgba(0,0,0,.55);border:2px solid #fff;';
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  return el;
}

// ---------------------------------------------------------------------------
// Popup HTML builders
// ---------------------------------------------------------------------------

export function jobPopupHTML(job: Job): string {
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
  <div style="margin-top:6px;color:#334155">${esc(issueTypeLabel(job.issueType))}</div>
  <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
    <span style="background:${jobColor(job.urgency)}1a;color:${jobColor(job.urgency)};border:1px solid ${jobColor(job.urgency)}40;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600">${esc(humanize(job.urgency))}</span>
    <span style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;font-size:11px">${esc(humanize(job.status))}</span>
  </div>
  <div style="margin-top:6px;color:#475569;font-size:12px">${win}</div>
  <div style="margin-top:2px;font-size:12px">${techLabel}</div>
  ${priceRow}
</div>`;
}

export function arPopupHTML(ar: ArCustomer): string {
  const { ring } = arColor(ar.oldestDays);
  const ageLabel = ar.oldestDays < 30 ? `${ar.oldestDays}d` : ar.oldestDays < 90 ? `${ar.oldestDays}d` : `${ar.oldestDays}d — overdue`;
  return `<div style="font:13px/1.45 system-ui,-apple-system;min-width:160px;max-width:220px">
  <div style="font-weight:700;font-size:14px;color:#0f172a">${esc(customerNameLabel(ar.name))}</div>
  <div style="margin-top:6px;font-size:20px;font-weight:700;color:${ring}">${formatCents(ar.owingCents)}</div>
  <div style="color:#64748b;font-size:12px;margin-top:2px">${ar.invoiceCount} invoice${ar.invoiceCount !== 1 ? 's' : ''} · oldest ${ageLabel}</div>
</div>`;
}
