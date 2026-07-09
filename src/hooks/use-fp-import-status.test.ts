import { describe, it, expect } from 'vitest';
import { nextPollDelay } from './use-fp-import-status';
import type { FpImportRun } from './use-fp-import-status';

function makeRun(status: string): FpImportRun {
  return {
    id: 'test-id',
    phase: 'customers',
    status,
    counts: {},
    error: null,
    startedAt: new Date().toISOString(),
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
});
