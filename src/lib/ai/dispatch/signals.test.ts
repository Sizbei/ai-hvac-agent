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

const { getLatestTechnicianLocation } = vi.hoisted(() => ({
  getLatestTechnicianLocation: vi.fn(async () => null),
}));
vi.mock('@/lib/tech/location-queries', () => ({ getLatestTechnicianLocation }));

import { loadDispatchSignals, businessDayUtcRange } from './signals';

beforeEach(() => {
  selectQueue.length = 0;
});

describe('businessDayUtcRange (same-day load counts the Eastern calendar day)', () => {
  it('summer EDT day → 04:00Z start, next-day 04:00Z end', () => {
    const { start, end } = businessDayUtcRange('2026-07-01');
    // EDT = UTC−4, so Eastern midnight is 04:00Z, not the naive 00:00Z.
    expect(start.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-02T04:00:00.000Z');
  });

  it('winter EST day → 05:00Z start, next-day 05:00Z end', () => {
    const { start, end } = businessDayUtcRange('2026-01-15');
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });
});

describe('loadDispatchSignals', () => {
  it('returns a defaulted row for every requested tech even with no data', async () => {
    // job has classification → 5 queries run (skill, rating, load, conversion, revenue), all empty.
    selectQueue.push([], [], [], [], []);
    const m = await loadDispatchSignals(
      'org',
      ['t1', 't2'],
      { jobType: 'no_cool', systemType: null },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      travelKm: null,
    });
    expect(m.get('t2')).toEqual({
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      travelKm: null,
    });
  });

  it('interprets aggregated rows into the per-tech signals', async () => {
    selectQueue.push(
      [{ techId: 't1', n: 7 }], // skill
      [{ techId: 't1', rating: '4.8' }], // rating (driver returns string for avg)
      [{ techId: 't1', n: 2 }], // load
      [{ techId: 't1', total: 4, sold: 2 }], // conversion → 0.5
      [{ techId: 't1', avgCents: '12000' }], // avg revenue (driver returns string for avg)
    );
    const m = await loadDispatchSignals(
      'org',
      ['t1'],
      { jobType: 'no_cool', systemType: 'central_ac' },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({
      skillJobsCompleted: 7,
      avgRating: 4.8,
      sameDayJobCount: 2,
      conversionRate: 0.5,
      avgJobRevenueCents: 12000,
      travelKm: null,
    });
  });

  it('skips the skill query and matches nobody when the job has no classification', async () => {
    // No jobType/systemType → skill query short-circuited; rating+load+conversion+revenue run.
    selectQueue.push([], [], [], []);
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

  describe('travel term', () => {
    beforeEach(() => {
      getLatestTechnicianLocation.mockReset();
      getLatestTechnicianLocation.mockResolvedValue(null); // no live fix → home base
    });

    it('stays null with no requestId (byte-identical to today)', async () => {
      selectQueue.push([], [], [], [], []); // 5 aggregates only
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
      );
      expect(m.get('t1')!.travelKm).toBeNull();
    });

    it('stays null when the request has no linked location', async () => {
      // 5 aggregates + empty job-coords row → no anchor read issued.
      selectQueue.push([], [], [], [], [], []);
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
        'req-1',
      );
      expect(m.get('t1')!.travelKm).toBeNull();
    });

    it('computes haversine km from the tech home base to the job coords', async () => {
      selectQueue.push(
        [], [], [], [], [],                     // 5 aggregates
        [{ lat: 36.33, lon: -82.38 }],          // job coords (near business base)
        [{ id: 't1', lat: 36.0, lon: -82.0 }],  // home base
      );
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
        'req-1',
      );
      const km = m.get('t1')!.travelKm;
      expect(km).not.toBeNull();
      expect(km!).toBeGreaterThan(0);
      expect(km!).toBeLessThan(60);
    });

    it('prefers a live GPS fix over the home base', async () => {
      getLatestTechnicianLocation.mockResolvedValue({
        latitude: 36.33,
        longitude: -82.38,
        accuracyM: null,
        capturedAt: '2026-06-24T00:00:00.000Z',
      } as never);
      selectQueue.push(
        [], [], [], [], [],
        [{ lat: 36.33, lon: -82.38 }],           // job coords == the live fix
        [{ id: 't1', lat: 10.0, lon: 10.0 }],    // far home base (should be ignored)
      );
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
        'req-1',
      );
      // Live fix coincides with the job → ~0 km, proving home base was ignored.
      expect(m.get('t1')!.travelKm!).toBeLessThan(1);
    });
  });
});
