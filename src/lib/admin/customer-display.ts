/**
 * Pure presentation helpers for the customers directory (people cards + drawer).
 * No React, no DB — just deterministic formatting so they can be unit-tested and
 * shared between the card grid and the drawer.
 */

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

/** The city from a "street, city, ST zip" address, or null. Takes the
 * second-to-last comma segment (the city sits before the state/zip). */
export function customerCity(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2] ?? null;
  return null;
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
