/**
 * Pure presentation helpers for the customers directory (people cards + drawer).
 * No React, no DB — just deterministic formatting so they can be unit-tested and
 * shared between the card grid and the drawer.
 */

import { BUSINESS_BASE_LOCATION } from '@/lib/config/business-location';
import { addressCity } from '@/lib/admin/contact-format';

/** Up to two initials from a customer name, ignoring parenthetical suffixes like
 * "(TCG)" so "Belk Morristown (TCG)" → "BM", not "B(". Falls back to the first
 * two characters, and to "?" when there's nothing usable. */
export function customerInitials(name: string | null): string {
  if (!name) return '?';
  const cleaned = name.replace(/\(.*?\)/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  // Two words → one initial each; one word → its first two letters.
  const initials =
    words.length > 1
      ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')
      : (words[0] ?? '').slice(0, 2);
  return initials.toUpperCase() || '?';
}

/** The city from a "street, city, ST zip" address, or null when the address
 * has no recognisable city (see `addressCity`: "Larkin Health Care, 1633
 * Fernhill Dr" used to show "Larkin Health Care" as the city). */
export function customerCity(address: string | null): string | null {
  return addressCity(address);
}

/** A short "last seen" label from an ISO date, relative to `now` (defaults to
 * the current time). Whole-day granularity; future dates read "upcoming". */
export function lastSeenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'never';
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days < 0) return 'upcoming';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Freshness tone for the last-seen dot: green ≤30d, amber ≤90d, muted beyond
 * (or never). Returned as a hex so it can drive an inline dot color. */
export function lastSeenTone(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '#9ca3af';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '#9ca3af';
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days < 0 || days <= 30) return '#16a34a';
  if (days <= 90) return '#d97706';
  return '#9ca3af';
}

const BOOKING_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_BASE_LOCATION.timezone,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Month / day / year of a booking in the business timezone (Eastern), so an
 * evening booking doesn't show as the next day the way UTC getters did. */
export function bookingDateParts(iso: string): {
  readonly month: string;
  readonly day: string;
  readonly year: string;
} {
  const parts = BOOKING_DATE_FORMAT.formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return { month: get('month'), day: get('day'), year: get('year') };
}

/**
 * The directory's one-line activity summary. A completed request is the best
 * signal ("Last service 3mo ago"); imported customers mostly have invoices
 * instead ("Last invoiced 1y ago"). `date` drives the freshness dot.
 */
export function customerActivity(
  c: { readonly lastServiceDate: string | null; readonly lastInvoiceDate?: string | null },
  now: Date = new Date(),
): { readonly label: string; readonly date: string | null } {
  if (c.lastServiceDate) {
    return { label: `Last service ${lastSeenLabel(c.lastServiceDate, now)}`, date: c.lastServiceDate };
  }
  if (c.lastInvoiceDate) {
    return { label: `Last invoiced ${lastSeenLabel(c.lastInvoiceDate, now)}`, date: c.lastInvoiceDate };
  }
  return { label: 'No service on record', date: null };
}

/** "1 invoice" / "2,660 customers" — a count with its noun, thousands separated. */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}
