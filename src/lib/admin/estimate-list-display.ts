/**
 * Display helpers for the estimates list (pure, unit-tested).
 */
import { formatCentsExact } from './money-format';

const DAY_MS = 86_400_000;

/**
 * Whole days an estimate has been waiting. Never negative: the browser clock
 * can sit a few ms behind the database's now(), which used to show "-1d" on a
 * brand-new estimate.
 */
export function estimateAgeDays(effectiveCreatedAt: string, now: number): number {
  const days = Math.floor((now - new Date(effectiveCreatedAt).getTime()) / DAY_MS);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

/**
 * The list Total. An undecided Good/Better/Best is valued at its highest
 * option, so it reads "up to $376.68" — the bookkeeper must not take it as
 * the amount the customer will pay. A sold (or single-option) estimate is its
 * plain amount.
 */
export function estimateTotalLabel(row: {
  readonly totalCents: number;
  readonly optionCount: number;
  readonly soldOptionId: string | null;
}): string {
  const amount = formatCentsExact(row.totalCents);
  return row.optionCount > 1 && row.soldOptionId === null ? `up to ${amount}` : amount;
}
