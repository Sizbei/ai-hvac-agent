/**
 * Job-duration estimation for duration-based scheduling.
 *
 * The DETERMINISTIC base table is the source of truth and the always-available
 * fallback (the "estimations first" decision). An optional LLM refinement reads
 * the free-text description and nudges the estimate, but is CLAMPED to a sane band
 * around the base [0.5×, 2×] ∩ [15, 480] min and falls back to the base on any
 * error / missing key — so a model mistake can never blow up the schedule by more
 * than one calendar block, and dispatch never depends on the LLM.
 */
import { generateText } from "ai";
import { getExtractionModel } from "@/lib/ai/provider";

// Base on-site minutes per job type (historical averages; tune from actuals).
const JOB_DURATION_DEFAULTS: Record<string, number> = {
  service_call: 90,
  maintenance: 60,
  diagnostic: 75,
  install: 480,
  estimate: 30,
  no_heat: 105,
  no_cool: 105,
  warranty: 90,
  inspection: 45,
  repair: 90,
};
const FALLBACK_BASE = 90; // unknown/null job type
const MIN_MINUTES = 15;
const MAX_MINUTES = 480;

function clampRound(mins: number): number {
  const c = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, mins));
  return Math.round(c / 15) * 15; // calendar blocks are 15-min granular
}

export interface DurationJob {
  readonly jobType: string | null;
  readonly systemType: string | null;
  readonly equipmentAgeBand: string | null;
  readonly description?: string | null;
}

export type DurationSource = "default" | "llm";
export interface DurationEstimate {
  readonly minutes: number;
  readonly source: DurationSource;
}

/** Deterministic estimate: base-by-type × system/age modifiers, clamped+rounded.
 * Pure — always returns a valid duration, including for a null/unknown job type. */
export function baseDurationMinutes(job: DurationJob): number {
  let d =
    (job.jobType ? JOB_DURATION_DEFAULTS[job.jobType] : undefined) ??
    FALLBACK_BASE;
  // System-complexity modifiers.
  if (job.systemType === "heat_pump") d *= 1.2;
  else if (job.systemType === "mini_split") d *= 1.3;
  else if (job.systemType === "boiler") d *= 1.4;
  // Equipment-age modifier (older = more surprises).
  if (job.equipmentAgeBand === "over_15") d *= 1.5;
  else if (job.equipmentAgeBand === "under_5") d *= 0.9;
  return clampRound(d);
}

/**
 * Best estimate for a job: the deterministic base, optionally refined by the LLM
 * from the free-text description. Always resolves (never throws) — on no
 * description, no key, parse failure, or any error it returns the base.
 */
export async function estimateJobDuration(
  orgId: string,
  job: DurationJob,
): Promise<DurationEstimate> {
  const base = baseDurationMinutes(job);
  const desc = job.description?.trim();
  if (!desc) return { minutes: base, source: "default" };

  try {
    const model = await getExtractionModel(orgId);
    const { text } = await generateText({
      model,
      prompt:
        `Estimate the on-site duration in MINUTES for this HVAC job.\n` +
        `Job type: ${job.jobType ?? "unknown"}\n` +
        `System: ${job.systemType ?? "unknown"}\n` +
        `Equipment age: ${job.equipmentAgeBand ?? "unknown"}\n` +
        `Baseline: ${base} minutes.\n` +
        `Description: ${desc}\n` +
        `Reply with ONLY an integer number of minutes.`,
    });
    const parsed = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { minutes: base, source: "default" };
    }
    // Bound the LLM to [0.5×, 2×] the deterministic base before clamp/round.
    const bounded = Math.max(base * 0.5, Math.min(base * 2, parsed));
    return { minutes: clampRound(bounded), source: "llm" };
  } catch {
    return { minutes: base, source: "default" };
  }
}
