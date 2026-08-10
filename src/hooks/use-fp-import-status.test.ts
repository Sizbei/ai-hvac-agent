import { describe, it, expect } from 'vitest';
import { nextPollDelay } from './use-fp-import-status';
import { STALE_RUN_THRESHOLD_MS } from '@/components/admin/fp-import/import-status-model';
import type { FpImportRun } from './use-fp-import-status';

function makeRun(status: string, startedAt: string = new Date().toISOString()): FpImportRun {
  return {
    id: 'test-id',
    phase: 'customers',
    status,
    counts: {},
    error: null,
    startedAt,
    finishedAt: null,
  };
}

describe('nextPollDelay', () => {
  it('returns null when runs array is empty (no active run)', () => {
    expect(nextPollDelay([])).toBeNull();
  });

  it('returns null when all runs are completed', () => {
    expect(nextPollDelay([makeRun('completed'), makeRun('completed')])).toBeNull();
  });

  it('returns null when all runs are failed', () => {
    expect(nextPollDelay([makeRun('failed')])).toBeNull();
  });

  it('returns 2500 when any run has status running', () => {
    expect(nextPollDelay([makeRun('completed'), makeRun('running')])).toBe(2500);
  });

  it('returns 2500 when the only run is running', () => {
    expect(nextPollDelay([makeRun('running')])).toBe(2500);
  });

  it('returns null when runs mix completed and failed but none running', () => {
    expect(nextPollDelay([makeRun('completed'), makeRun('failed')])).toBeNull();
  });

  it('returns 2500 for a running run that is still fresh, given an explicit nowMs', () => {
    const now = new Date('2024-01-01T12:00:00Z').getTime();
    const run = makeRun('running', new Date(now - 5 * 60 * 1000).toISOString());
    expect(nextPollDelay([run], now)).toBe(2500);
  });

  it('returns null for a running run that has gone stale (Rfieldpulse-import-2) — Refresh must not stay hidden forever', () => {
    const now = new Date('2024-01-01T12:00:00Z').getTime();
    const run = makeRun('running', new Date(now - (STALE_RUN_THRESHOLD_MS + 1000)).toISOString());
    expect(nextPollDelay([run], now)).toBeNull();
  });

  it('keeps polling when at least one running run is still fresh, even if another is stale', () => {
    const now = new Date('2024-01-01T12:00:00Z').getTime();
    const staleRun = makeRun('running', new Date(now - (STALE_RUN_THRESHOLD_MS + 1000)).toISOString());
    const freshRun = makeRun('running', new Date(now - 5 * 60 * 1000).toISOString());
    expect(nextPollDelay([staleRun, freshRun], now)).toBe(2500);
  });
});
