import { describe, it, expect } from 'vitest';
import { scoreTechnician, rankTechnicians, classifyDispatch, type DispatchSignals } from './score';

const job = { jobType: 'no_cool', systemType: 'central_ac', urgency: 'standard' } as const;

function signals(
  technicianId: string,
  over: Partial<DispatchSignals['tech']> = {},
): DispatchSignals {
  return {
    job,
    tech: {
      technicianId,
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      ...over,
    },
  };
}

describe('scoreTechnician', () => {
  it('marks a tech with zero matching jobs as not skill-matched', () => {
    const r = scoreTechnician(signals('t1', { skillJobsCompleted: 0 }));
    expect(r.skillMatched).toBe(false);
    expect(r.reasons.some((x) => x.includes('no prior'))).toBe(true);
  });

  it('marks a tech with >=1 matching job as skill-matched', () => {
    const r = scoreTechnician(signals('t1', { skillJobsCompleted: 1 }));
    expect(r.skillMatched).toBe(true);
  });

  it('weights skill, quality, conversion, load, and value into [0,1]', () => {
    // Max signals → 0.4 + 0.2 + 0.15 + 0.15 + 0.10 = 1.0 (value maxes at the $1,500 cap).
    const best = scoreTechnician(
      signals('t1', {
        skillJobsCompleted: 10,
        avgRating: 5,
        conversionRate: 1,
        sameDayJobCount: 0,
        avgJobRevenueCents: 150000,
      }),
    );
    expect(best.score).toBeCloseTo(1.0, 5);
    // Skill depth caps at 10 jobs; value caps at the revenue cap.
    const capped = scoreTechnician(
      signals('t1', {
        skillJobsCompleted: 50,
        avgRating: 5,
        conversionRate: 1,
        sameDayJobCount: 0,
        avgJobRevenueCents: 300000,
      }),
    );
    expect(capped.score).toBeCloseTo(1.0, 5);
  });

  it('defaults a missing rating to 3.5/5 for the quality term', () => {
    // skill 0 (still scored), rating null → 3.5/5 * 0.2, conversion 0, load 0 → 0.15
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 }),
    );
    expect(r.score).toBeCloseTo((3.5 / 5) * 0.2 + 0.15, 5);
  });

  it('rewards a higher conversion rate and surfaces a close-rate reason', () => {
    const lo = scoreTechnician(signals('a', { skillJobsCompleted: 5, conversionRate: 0.1 }));
    const hi = scoreTechnician(signals('b', { skillJobsCompleted: 5, conversionRate: 0.9 }));
    expect(hi.score).toBeGreaterThan(lo.score);
    expect(hi.reasons.some((x) => x.includes('90% close rate'))).toBe(true);
    expect(lo.reasons.some((x) => x.includes('close rate'))).toBe(true);
  });

  it('omits the close-rate reason when conversionRate is 0', () => {
    const r = scoreTechnician(signals('t1', { skillJobsCompleted: 3, conversionRate: 0 }));
    expect(r.reasons.some((x) => x.includes('close rate'))).toBe(false);
  });

  it('penalizes same-day load, flooring at 6 jobs', () => {
    const light = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 0 }));
    const heavy = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 6 }));
    const overloaded = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 99 }));
    expect(heavy.score).toBeLessThan(light.score);
    expect(overloaded.score).toBeCloseTo(heavy.score, 5); // floored at 6
  });

  it('produces human-readable reasons', () => {
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 7, avgRating: 4.9, sameDayJobCount: 2 }),
    );
    expect(r.reasons).toContain('7 prior no_cool jobs');
    expect(r.reasons).toContain('4.9★');
    expect(r.reasons).toContain('2 jobs today');
  });
});

describe('rankTechnicians', () => {
  it('drops non-skill-matched techs and sorts the rest by score desc', () => {
    const ranked = rankTechnicians([
      signals('unqualified', { skillJobsCompleted: 0, avgRating: 5 }),
      signals('ok', { skillJobsCompleted: 2, avgRating: 4.0, sameDayJobCount: 3 }),
      signals('best', { skillJobsCompleted: 9, avgRating: 5.0, sameDayJobCount: 0 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['best', 'ok']);
  });

  it('returns an empty array when no tech is skill-matched', () => {
    const ranked = rankTechnicians([
      signals('a', { skillJobsCompleted: 0 }),
      signals('b', { skillJobsCompleted: 0 }),
    ]);
    expect(ranked).toEqual([]);
  });

  it('lets conversion change the order between otherwise-equal techs', () => {
    const ranked = rankTechnicians([
      signals('a', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1, conversionRate: 0.2 }),
      signals('b', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1, conversionRate: 0.8 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['b', 'a']);
  });

  it('breaks ties deterministically by technicianId', () => {
    const ranked = rankTechnicians([
      signals('zeta', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
      signals('alpha', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['alpha', 'zeta']);
  });
});

describe('travel-aware scoring + confidence classification', () => {
  const baseTech = {
    skillJobsCompleted: 5,
    avgRating: 4 as number | null,
    sameDayJobCount: 2,
    conversionRate: 0.5,
    avgJobRevenueCents: 0,
  };
  const job = { jobType: 'repair', systemType: null, urgency: 'standard' };

  it('ranks a closer tech above a farther one, all else equal', () => {
    const near = scoreTechnician({ job, tech: { technicianId: 'a', ...baseTech, travelKm: 2 } });
    const far = scoreTechnician({ job, tech: { technicianId: 'b', ...baseTech, travelKm: 35 } });
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.reasons.some((r) => r.includes('km away'))).toBe(true);
  });

  it('is byte-identical to the no-travel composite when travelKm is absent', () => {
    const without = scoreTechnician({ job, tech: { technicianId: 'a', ...baseTech } });
    const nullTravel = scoreTechnician({ job, tech: { technicianId: 'a', ...baseTech, travelKm: null } });
    expect(nullTravel.score).toBe(without.score);
  });

  it('classifyDispatch: empty ranking → queued_no_fit', () => {
    expect(classifyDispatch([]).outcome).toBe('queued_no_fit');
  });

  it('classifyDispatch: a clear winner commits to the top tech', () => {
    const ranked = [
      { technicianId: 'a', score: 0.8, reasons: [], skillMatched: true },
      { technicianId: 'b', score: 0.5, reasons: [], skillMatched: true },
    ];
    expect(classifyDispatch(ranked)).toEqual({ outcome: 'committed', technicianId: 'a' });
  });

  it('classifyDispatch: a near-tie defers to a human (queued_ambiguous)', () => {
    const ranked = [
      { technicianId: 'a', score: 0.81, reasons: [], skillMatched: true },
      { technicianId: 'b', score: 0.80, reasons: [], skillMatched: true },
    ];
    expect(classifyDispatch(ranked).outcome).toBe('queued_ambiguous');
  });

  it('classifyDispatch: a lone candidate commits (infinite gap)', () => {
    const ranked = [{ technicianId: 'a', score: 0.3, reasons: [], skillMatched: true }];
    expect(classifyDispatch(ranked)).toEqual({ outcome: 'committed', technicianId: 'a' });
  });
});

describe('Probook-parity: expected-value term + urgency tier', () => {
  const baseTech = {
    skillJobsCompleted: 5,
    avgRating: 4 as number | null,
    sameDayJobCount: 2,
    conversionRate: 0.5,
    avgJobRevenueCents: 0,
  };
  const job = { jobType: 'repair', systemType: null, urgency: 'standard' };

  it('ranks a higher-avg-ticket tech above an identical lower-ticket tech', () => {
    const rich = scoreTechnician({ job, tech: { technicianId: 'a', ...baseTech, avgJobRevenueCents: 150000 } });
    const poor = scoreTechnician({ job, tech: { technicianId: 'b', ...baseTech, avgJobRevenueCents: 0 } });
    expect(rich.score).toBeGreaterThan(poor.score);
    expect(rich.reasons.some((r) => r.includes('avg ticket'))).toBe(true);
  });

  it('an emergency auto-commits a near-tie a standard job would queue', () => {
    // gap 0.03: below the normal 0.08 gate (queue) but above the 0.02 emergency gate (commit).
    const ranked = [
      { technicianId: 'a', score: 0.83, reasons: [], skillMatched: true },
      { technicianId: 'b', score: 0.80, reasons: [], skillMatched: true },
    ];
    expect(classifyDispatch(ranked).outcome).toBe('queued_ambiguous');
    expect(classifyDispatch(ranked, 'emergency')).toEqual({ outcome: 'committed', technicianId: 'a' });
  });

  it('emergency still queues when there is no eligible candidate', () => {
    expect(classifyDispatch([], 'emergency').outcome).toBe('queued_no_fit');
  });
});
