import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  // A chainable Proxy that resolves to the next queued result when awaited.
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(resolved);
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
  },
}));

import { loadDispatchSignals } from './signals';

beforeEach(() => {
  selectQueue.length = 0;
});

describe('loadDispatchSignals', () => {
  it('returns a defaulted row for every requested tech even with no data', async () => {
    // job has classification → 3 queries run (skill, rating, load), all empty.
    selectQueue.push([], [], []);
    const m = await loadDispatchSignals(
      'org',
      ['t1', 't2'],
      { jobType: 'no_cool', systemType: null },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({ skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
    expect(m.get('t2')).toEqual({ skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
  });

  it('interprets aggregated rows into the per-tech signals', async () => {
    selectQueue.push(
      [{ techId: 't1', n: 7 }], // skill
      [{ techId: 't1', rating: '4.8' }], // rating (driver returns string for avg)
      [{ techId: 't1', n: 2 }], // load
    );
    const m = await loadDispatchSignals(
      'org',
      ['t1'],
      { jobType: 'no_cool', systemType: 'central_ac' },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({ skillJobsCompleted: 7, avgRating: 4.8, sameDayJobCount: 2 });
  });

  it('skips the skill query and matches nobody when the job has no classification', async () => {
    // No jobType/systemType → skill query is short-circuited; only rating+load run.
    selectQueue.push([], []);
    const m = await loadDispatchSignals(
      'org',
      ['t1'],
      { jobType: null, systemType: null },
      '2026-06-24',
    );
    expect(m.get('t1')!.skillJobsCompleted).toBe(0);
  });

  it('returns an empty map for no technicians without querying', async () => {
    const m = await loadDispatchSignals(
      'org',
      [],
      { jobType: 'no_cool', systemType: null },
      '2026-06-24',
    );
    expect(m.size).toBe(0);
  });
});
