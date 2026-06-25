/**
 * Pure, deterministic dispatch scoring. No IO, no LLM — an auto-assignment is a
 * money/ops decision that must be explainable, cheap, and hallucination-free.
 * All weights are constants (ML-tunable later). See the design spec.
 */

export interface DispatchSignals {
  readonly job: {
    readonly jobType: string | null;
    readonly systemType: string | null;
    readonly urgency: string;
  };
  readonly tech: {
    readonly technicianId: string;
    /** Completed jobs whose jobType OR systemType matches the incoming job (counted once). */
    readonly skillJobsCompleted: number;
    readonly avgRating: number | null;
    readonly sameDayJobCount: number;
    /** Sold estimates / estimated jobs for this tech, in [0,1] (0 when unknown). */
    readonly conversionRate: number;
    /** Avg invoice total on this tech's completed jobs; surfaced as a reason, not yet weighted. */
    readonly avgJobRevenueCents: number;
  };
}

export interface RankedTech {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
}

// Scoring weights (sum to 1.0). Provisional — to be tuned on pilot data (spec §6.3).
const W_SKILL = 0.4;
const W_QUALITY = 0.2;
const W_CONVERSION = 0.25;
const W_LOAD = 0.15;

const SKILL_DEPTH_CAP = 10; // jobs beyond this don't increase skill depth
const LOAD_CAP = 6; // same-day jobs beyond this don't increase the load penalty
const DEFAULT_RATING = 3.5; // assumed quality for a tech with no ratings yet

/** A short label for the job's specialty, for human-readable reasons. */
function skillLabel(job: DispatchSignals['job']): string {
  return job.jobType ?? job.systemType ?? 'matching';
}

export function scoreTechnician(signals: DispatchSignals): RankedTech {
  const { job, tech } = signals;
  const skillMatched = tech.skillJobsCompleted > 0;

  const skillDepth = Math.min(tech.skillJobsCompleted, SKILL_DEPTH_CAP) / SKILL_DEPTH_CAP;
  const quality = (tech.avgRating ?? DEFAULT_RATING) / 5;
  const conversion = Math.min(Math.max(tech.conversionRate, 0), 1);
  const load = 1 - Math.min(tech.sameDayJobCount, LOAD_CAP) / LOAD_CAP;

  const score =
    skillDepth * W_SKILL + quality * W_QUALITY + conversion * W_CONVERSION + load * W_LOAD;

  const reasons: string[] = [];
  reasons.push(
    skillMatched
      ? `${tech.skillJobsCompleted} prior ${skillLabel(job)} jobs`
      : `no prior ${skillLabel(job)} experience`,
  );
  if (tech.avgRating != null) reasons.push(`${tech.avgRating.toFixed(1)}★`);
  if (tech.conversionRate > 0) reasons.push(`${Math.round(tech.conversionRate * 100)}% close rate`);
  reasons.push(`${tech.sameDayJobCount} jobs today`);

  return { technicianId: tech.technicianId, score, reasons, skillMatched };
}

/**
 * Score every candidate, drop the non-skill-matched, and sort by score desc.
 * Ties break by technicianId (ascending) so the ordering is fully deterministic.
 */
export function rankTechnicians(candidates: readonly DispatchSignals[]): RankedTech[] {
  return candidates
    .map(scoreTechnician)
    .filter((r) => r.skillMatched)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.technicianId.localeCompare(b.technicianId),
    );
}
