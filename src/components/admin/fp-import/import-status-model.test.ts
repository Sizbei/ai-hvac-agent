import { describe, it, expect } from 'vitest';
import {
  latestRunPerPhase,
  progressPct,
  formatElapsed,
  runTone,
  type FpImportRunSummary,
  type FpRunCounts,
} from './import-status-model';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRun(
  partial: Partial<FpImportRunSummary> & { phase: string; startedAt: string },
): FpImportRunSummary {
  return {
    id: 'run-1',
    status: 'completed',
    counts: {},
    error: null,
    finishedAt: null,
    ...partial,
  };
}

// ─── latestRunPerPhase ───────────────────────────────────────────────────────

describe('latestRunPerPhase', () => {
  it('empty array → all phases undefined', () => {
    const result = latestRunPerPhase([]);
    expect(result['technicians']).toBeUndefined();
    expect(result['customers']).toBeUndefined();
    expect(result['jobs']).toBeUndefined();
    expect(result['invoices']).toBeUndefined();
  });

  it('one run per phase → returns each', () => {
    const runs = [
      makeRun({ id: 'r1', phase: 'technicians', startedAt: '2024-01-01T10:00:00Z' }),
      makeRun({ id: 'r2', phase: 'customers', startedAt: '2024-01-01T10:01:00Z' }),
      makeRun({ id: 'r3', phase: 'jobs', startedAt: '2024-01-01T10:02:00Z' }),
      makeRun({ id: 'r4', phase: 'invoices', startedAt: '2024-01-01T10:03:00Z' }),
    ];
    const result = latestRunPerPhase(runs);
    expect(result['technicians']?.id).toBe('r1');
    expect(result['customers']?.id).toBe('r2');
    expect(result['jobs']?.id).toBe('r3');
    expect(result['invoices']?.id).toBe('r4');
  });

  it('two runs for same phase → returns the one with later startedAt', () => {
    const runs = [
      makeRun({ id: 'r-old', phase: 'customers', startedAt: '2024-01-01T09:00:00Z' }),
      makeRun({ id: 'r-new', phase: 'customers', startedAt: '2024-01-01T10:00:00Z' }),
    ];
    const result = latestRunPerPhase(runs);
    expect(result['customers']?.id).toBe('r-new');
  });

  it('runs for unknown phases → not included in result', () => {
    const runs = [
      makeRun({ id: 'r-unknown', phase: 'unknown-phase', startedAt: '2024-01-01T10:00:00Z' }),
      makeRun({ id: 'r-tech', phase: 'technicians', startedAt: '2024-01-01T10:00:00Z' }),
    ];
    const result = latestRunPerPhase(runs);
    expect('unknown-phase' in result).toBe(false);
    expect(result['technicians']?.id).toBe('r-tech');
  });
});

// ─── progressPct ─────────────────────────────────────────────────────────────

describe('progressPct', () => {
  it('total=null → null', () => {
    const counts: FpRunCounts = { total: null, created: 50 };
    expect(progressPct(counts)).toBeNull();
  });

  it('total=0 → null', () => {
    const counts: FpRunCounts = { total: 0, created: 10 };
    expect(progressPct(counts)).toBeNull();
  });

  it('total=100, processed=50 → 50', () => {
    const counts: FpRunCounts = { total: 100, created: 30, updated: 10, skipped: 10, errors: 0 };
    expect(progressPct(counts)).toBe(50);
  });

  it('total=100, processed=110 → 100 (clamped)', () => {
    const counts: FpRunCounts = { total: 100, created: 110 };
    expect(progressPct(counts)).toBe(100);
  });

  it('all counts zero, total=100 → 0', () => {
    const counts: FpRunCounts = { total: 100 };
    expect(progressPct(counts)).toBe(0);
  });

  it('total=undefined → null', () => {
    const counts: FpRunCounts = { created: 50 };
    expect(progressPct(counts)).toBeNull();
  });
});

// ─── formatElapsed ───────────────────────────────────────────────────────────

describe('formatElapsed', () => {
  it('30 seconds elapsed → "30s"', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = '2024-01-01T10:00:30Z';
    expect(formatElapsed(start, end)).toBe('30s');
  });

  it('90 seconds elapsed → "1m 30s"', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = '2024-01-01T10:01:30Z';
    expect(formatElapsed(start, end)).toBe('1m 30s');
  });

  it('0 or negative elapsed → "0s"', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = '2024-01-01T09:59:59Z'; // 1 second before start
    expect(formatElapsed(start, end)).toBe('0s');
  });

  it('exactly 60 seconds → "1m 0s"', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = '2024-01-01T10:01:00Z';
    expect(formatElapsed(start, end)).toBe('1m 0s');
  });

  it('61 seconds → "1m 1s"', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = '2024-01-01T10:01:01Z';
    expect(formatElapsed(start, end)).toBe('1m 1s');
  });

  it('59600ms (59.6s) elapsed → "1m 0s"', () => {
    const start = '2024-01-01T10:00:00.000Z';
    const end = '2024-01-01T10:00:59.600Z';
    expect(formatElapsed(start, end)).toBe('1m 0s');
  });

  it('119500ms (119.5s) elapsed → "2m 0s"', () => {
    const start = '2024-01-01T10:00:00.000Z';
    // 119.5s rounding to 120s (2m 0s)
    // Manually verify: 119500ms / 1000 = 119.5, Math.round(119.5) = 120
    // 120 / 60 = 2 min, 120 % 60 = 0 sec → "2m 0s"
    expect(formatElapsed(start, '2024-01-01T10:01:59.500Z')).toBe('2m 0s');
  });
});

// ─── runTone ─────────────────────────────────────────────────────────────────

describe('runTone', () => {
  it("'running' → 'info'", () => {
    expect(runTone('running')).toBe('info');
  });

  it("'completed' → 'positive'", () => {
    expect(runTone('completed')).toBe('positive');
  });

  it("'failed' → 'destructive'", () => {
    expect(runTone('failed')).toBe('destructive');
  });

  it("'' → 'muted'", () => {
    expect(runTone('')).toBe('muted');
  });

  it("'unknown' → 'muted'", () => {
    expect(runTone('unknown')).toBe('muted');
  });
});
