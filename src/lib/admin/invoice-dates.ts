/**
 * Short issued-date label for the invoices list. "Jun 1" alone is ambiguous
 * next to "492d overdue", so a date outside the current year carries its year.
 * UTC-rendered: mirrored source dates are UTC-pinned.
 */
export function shortIssuedDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}
