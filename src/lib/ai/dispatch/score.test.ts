import { describe, it, expect } from 'vitest';
import { scoreTechnician, rankTechnicians, type DispatchSignals } from './score';

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

  it('weights skill depth, quality, and load into [0,1]', () => {
    // Max signals: 10+ skill jobs, 5.0 rating, 0 load → 0.5 + 0.3 + 0.2 = 1.0
    const best = scoreTechnician(
      signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 0 }),
    );
    expect(best.score).toBeCloseTo(1.0, 5);
    // Skill depth caps at 10 jobs.
    const capped = scoreTechnician(
      signals('t1', { skillJobsCompleted: 50, avgRating: 5, sameDayJobCount: 0 }),
    );
    expect(capped.score).toBeCloseTo(1.0, 5);
  });

  it('defaults a missing rating to 3.5/5 for the quality term', () => {
    // skill 0 (still scored), rating null → 3.5/5 * 0.3, load 0 → 0.2
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 }),
    );
    expect(r.score).toBeCloseTo((3.5 / 5) * 0.3 + 0.2, 5);
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

  it('breaks ties deterministically by technicianId', () => {
    const ranked = rankTechnicians([
      signals('zeta', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
      signals('alpha', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['alpha', 'zeta']);
  });
});
