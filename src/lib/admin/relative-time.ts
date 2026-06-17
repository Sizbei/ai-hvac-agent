/**
 * Compact relative-time formatter for admin list rows ("4m", "2h", "3d").
 * Falls back to a short date for anything older than a week. Returns "—" for
 * missing/unparseable input so callers can render it verbatim.
 */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return '—';

  const diffMs = Date.now() - ms;
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
