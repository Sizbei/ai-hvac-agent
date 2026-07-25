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
    // Chain-origin lookup (loadChainOrigins) uses db.execute. Default: no
    // predecessors, so travel falls back to anchors and existing assertions hold.
    // A test may override with dbMod.db.execute.mockResolvedValueOnce(...).
    execute: vi.fn(async () => ({ rows: [] as unknown[] })),
  },
}));

const { getLatestTechnicianLocations } = vi.hoisted(() => ({
  // Batch helper: latest fix per tech in one query. Default = no fixes.
  getLatestTechnicianLocations: vi.fn(
    async () => new Map<string, { latitude: number; longitude: number }>(),
  ),
}));
vi.mock('@/lib/tech/location-queries', () => ({ getLatestTechnicianLocations }));

const { routingEnabled, durationMatrix } = vi.hoisted(() => ({
  routingEnabled: vi.fn(() => false), // routing off by default → haversine only
  durationMatrix: vi.fn(async () => [] as (number | null)[]),
}));
vi.mock('./travel', () => ({ routingEnabled, durationMatrix }));

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
    // job has classification → 5 aggregates + 3 duration-fit queries (estimate,
    // booked, availability), all empty → duration-fit defaults.
    selectQueue.push([], [], [], [], [], [], [], []);
    const m = await loadDispatchSignals(
      'org',
      ['t1', 't2'],
      { jobType: 'no_cool', systemType: null },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({
      skillJobsCompleted: 0,
      skillJobsCompletedRecent: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      travelKm: null,
      travelMinutes: null,
      bookedMinutes: 0,
      dayMinutes: 720,
      thisJobEstimate: 0,
    });
    expect(m.get('t2')).toEqual({
      skillJobsCompleted: 0,
      skillJobsCompletedRecent: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      travelKm: null,
      travelMinutes: null,
      bookedMinutes: 0,
      dayMinutes: 720,
      thisJobEstimate: 0,
    });
  });

  it('interprets aggregated rows into the per-tech signals', async () => {
    selectQueue.push(
      [{ techId: 't1', n: 7, nRecent: 3 }], // skill (all-time 7, recent 3)
      [{ techId: 't1', rating: '4.8' }], // rating (driver returns string for avg)
      [{ techId: 't1', n: 2 }], // load
      [{ techId: 't1', total: 4, sold: 2 }], // conversion → 0.5
      [{ techId: 't1', avgCents: '12000' }], // avg revenue (driver returns string for avg)
      // No requestId → the estimate query short-circuits (no shift); only the
      // booked + availability duration-fit queries consume from the queue.
      [{ techId: 't1', booked: 120 }], // booked same-day minutes
      // availability slot 480→1020 = 540 min; dayOfWeek 3 matches Wed 2026-06-24.
      [{ techId: 't1', startMinute: 480, endMinute: 1020, dayOfWeek: 3 }],
    );
    const m = await loadDispatchSignals(
      'org',
      ['t1'],
      { jobType: 'no_cool', systemType: 'central_ac' },
      '2026-06-24',
    );
    expect(m.get('t1')).toEqual({
      skillJobsCompleted: 7,
      skillJobsCompletedRecent: 3,
      avgRating: 4.8,
      sameDayJobCount: 2,
      conversionRate: 0.5,
      avgJobRevenueCents: 12000,
      travelKm: null,
      travelMinutes: null,
      bookedMinutes: 120,
      dayMinutes: 540,
      thisJobEstimate: 0, // no requestId → estimate stays 0
    });
  });

  it('skips the skill query and matches nobody when the job has no classification', async () => {
    // No jobType/systemType → skill query short-circuited; rating+load+conversion+revenue run.
    // No requestId → estimate query short-circuits (no shift); booked + availability run.
    selectQueue.push([], [], [], [], [], []);
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
      getLatestTechnicianLocations.mockReset();
      getLatestTechnicianLocations.mockResolvedValue(new Map()); // no live fix → home base
      routingEnabled.mockReturnValue(false); // haversine-only unless a test opts in
      durationMatrix.mockReset();
      durationMatrix.mockResolvedValue([]);
    });

    it('stays null with no requestId (byte-identical to today)', async () => {
      // 5 aggregates + booked + availability (no requestId → estimate short-circuits).
      selectQueue.push([], [], [], [], [], [], []);
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
      );
      expect(m.get('t1')!.travelKm).toBeNull();
    });

    it('stays null when the request has no linked location', async () => {
      // 5 aggregates + 3 duration-fit + empty job-coords row → no anchor read issued.
      selectQueue.push([], [], [], [], [], [], [], [], []);
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
        [], [], [],                             // 3 duration-fit (estimate/booked/availability)
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
      getLatestTechnicianLocations.mockResolvedValue(
        new Map([['t1', { latitude: 36.33, longitude: -82.38 }]]) as never,
      );
      selectQueue.push(
        [], [], [], [], [],
        [], [], [],                              // 3 duration-fit
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

    it('overlays road drive-minutes when routing is enabled (km still computed)', async () => {
      routingEnabled.mockReturnValue(true);
      durationMatrix.mockResolvedValue([12]); // one anchor → 12 min drive
      getLatestTechnicianLocations.mockResolvedValue(
        new Map([['t1', { latitude: 36.0, longitude: -82.0 }]]),
      );
      selectQueue.push(
        [], [], [], [], [],
        [], [], [],                    // 3 duration-fit
        [{ lat: 36.33, lon: -82.38 }], // job coords
        [{ id: 't1', lat: 36.0, lon: -82.0 }], // home base (unused; live fix present)
      );
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
        'req-1',
      );
      expect(m.get('t1')!.travelMinutes).toBe(12);
      // Haversine km is still computed as the fallback signal.
      expect(m.get('t1')!.travelKm).not.toBeNull();
      expect(durationMatrix).toHaveBeenCalledOnce();
    });

    it('keeps travelMinutes null (haversine only) when routing prices no origin', async () => {
      routingEnabled.mockReturnValue(true);
      durationMatrix.mockResolvedValue([null]); // provider couldn't price the tech
      getLatestTechnicianLocations.mockResolvedValue(
        new Map([['t1', { latitude: 36.0, longitude: -82.0 }]]),
      );
      selectQueue.push(
        [], [], [], [], [],
        [], [], [],                    // 3 duration-fit
        [{ lat: 36.33, lon: -82.38 }],
        [{ id: 't1', lat: 36.0, lon: -82.0 }],
      );
      const m = await loadDispatchSignals(
        'org',
        ['t1'],
        { jobType: 'no_cool', systemType: null },
        '2026-06-24',
        'req-1',
      );
      expect(m.get('t1')!.travelMinutes).toBeNull();
      expect(m.get('t1')!.travelKm).not.toBeNull();
    });

    it("skips the routing call when skipRouting is set (haversine only)", async () => {
      routingEnabled.mockReturnValue(true);
      durationMatrix.mockResolvedValue([12]);
      getLatestTechnicianLocations.mockResolvedValue(
        new Map([["t1", { latitude: 36.0, longitude: -82.0 }]]),
      );
      selectQueue.push(
        [], [], [], [], [],
        [], [], [],                    // 3 duration-fit
        [{ lat: 36.33, lon: -82.38 }], // job coords
        [{ id: "t1", lat: 36.0, lon: -82.0 }], // home base
      );
      const m = await loadDispatchSignals(
        "org",
        ["t1"],
        { jobType: "no_cool", systemType: null },
        "2026-06-24",
        "req-1",
        { skipRouting: true },
      );
      // Haversine km present, but routing was NOT invoked (shadow saves ORS quota).
      expect(m.get("t1")!.travelKm).not.toBeNull();
      expect(m.get("t1")!.travelMinutes).toBeNull();
      expect(durationMatrix).not.toHaveBeenCalled();
    });

    it('uses a predecessor job origin over the anchor when one exists', async () => {
      // db.execute returns a predecessor near the job → chain km ~0.
      const dbMod = await import('@/lib/db');
      (dbMod.db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ tech_id: 't1', lat: 36.33, lon: -82.38 }],
      });
      selectQueue.push(
        [], [], [], [], [],
        [], [], [],                             // 3 duration-fit
        [{ lat: 36.33, lon: -82.38 }],          // job coords == predecessor
        [{ id: 't1', lat: 10.0, lon: 10.0 }],   // far home base (should be ignored)
      );
      const m = await loadDispatchSignals(
        'org', ['t1'], { jobType: 'no_cool', systemType: null }, '2026-06-24', 'req-1',
      );
      expect(m.get('t1')!.travelKm!).toBeLessThan(1); // predecessor origin won
    });
  });
});
