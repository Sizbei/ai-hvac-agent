/**
 * Rung A demand forecaster — pure, deterministic, no I/O (the dispatch/score.ts
 * pattern). Seasonal-naïve over same-weekday-last-4-weeks: the credible signal at
 * pilot data scale. Floors at 0 (count data) and falls back to the overall mean
 * when there is less than one full week of history. Prediction intervals are left
 * undefined here — h-step bands come from the Phase 8 backtest. (Probook v3 §6.2.)
 */

export interface DailyPoint {
  readonly day: string; // ISO yyyy-mm-dd
  readonly value: number;
}

export interface ForecastPoint {
  readonly day: string;
  readonly value: number;
  readonly lo?: number;
  readonly hi?: number;
}

const WEEKDAY_LOOKBACK = 4; // same-weekday last-4-weeks

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

const floorNonNeg = (n: number): number => Math.max(0, Math.round(n));

export function seasonalNaive(
  series: readonly DailyPoint[],
  horizonDays: number,
): ForecastPoint[] {
  if (series.length === 0) return [];

  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const lastDay = sorted[sorted.length - 1].day;
  const haveAWeek = sorted.length >= 7;
  const overallMean =
    sorted.reduce((s, p) => s + p.value, 0) / sorted.length;

  // Index recent values by weekday, most-recent first, capped at the lookback.
  const byWeekday = new Map<number, number[]>();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const wd = weekdayOf(sorted[i].day);
    const arr = byWeekday.get(wd) ?? [];
    if (arr.length < WEEKDAY_LOOKBACK) arr.push(sorted[i].value);
    byWeekday.set(wd, arr);
  }

  const out: ForecastPoint[] = [];
  for (let h = 1; h <= horizonDays; h++) {
    const day = addDaysIso(lastDay, h);
    let value: number;
    if (!haveAWeek) {
      value = overallMean;
    } else {
      const recent = byWeekday.get(weekdayOf(day));
      value =
        recent && recent.length > 0
          ? recent.reduce((s, v) => s + v, 0) / recent.length
          : overallMean;
    }
    out.push({ day, value: floorNonNeg(value) });
  }
  return out;
}
