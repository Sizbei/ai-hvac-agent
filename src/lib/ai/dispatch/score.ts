/**
 * Pure, deterministic dispatch scoring. No IO, no LLM — an auto-assignment is a
 * money/ops decision that must be explainable, cheap, and hallucination-free.
 * All weights are constants (ML-tunable later). See the design spec.
 */
import { formatCents } from "@/lib/admin/ops-insights-format";
import { humanizeCode, inSentence, jobTypeLabel } from "@/lib/admin/request-labels";

/** Reasons read as short sentences: first letter capitalised, nothing else touched. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
    /** Same-category completed jobs within the recency window (180d). Drives skill
     * DEPTH; the all-time skillJobsCompleted still gates skillMatched so a proven
     * tech isn't locked out by a quiet quarter. */
    readonly skillJobsCompletedRecent: number;
    /** Σ estimated duration (min) of same-day non-cancelled assigned jobs. */
    readonly bookedMinutes: number;
    /** Total working minutes in the tech's day (sumAvailabilityMinutes). */
    readonly dayMinutes: number;
    /** Estimated on-site minutes for THIS job. */
    readonly thisJobEstimate: number;
    readonly avgRating: number | null;
    readonly sameDayJobCount: number;
    /** Sold estimates / estimated jobs for this tech, in [0,1] (0 when unknown). */
    readonly conversionRate: number;
    /** Avg invoice total on this tech's completed jobs — the expected-value ranking
     * signal (W_VALUE), capped at REVENUE_CAP_CENTS, plus a "$X avg ticket" reason. */
    readonly avgJobRevenueCents: number;
    /** Straight-line km from the tech's anchor (live location or home base) to the
     * job, or null when either coordinate is unknown. When present, travel becomes
     * the DOMINANT factor (location-primary dispatch); when null the score is
     * byte-identical to the no-travel composite. */
    readonly travelKm?: number | null;
    /** Road drive-time (minutes) from the tech's anchor to the job, when a routing
     * provider is configured. PREFERRED over travelKm — a tech 40 km up the
     * highway can beat one 15 km cross-town. Null → fall back to travelKm. */
    readonly travelMinutes?: number | null;
  };
}

export interface RankedTech {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
  /** Travel inputs passed through for the dispatch-decision audit, so recorded
   * decisions carry BOTH signals — the routing-vs-haversine A/B and the
   * W_TRAVEL/cap tuning read these off dispatch_decisions.candidates. Null when
   * that signal wasn't available at scoring time. */
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
}

// Scoring weights (sum to 1.0). Provisional — to be tuned on pilot data (spec §6.3).
const W_SKILL = 0.4;
const W_QUALITY = 0.2;
const W_CONVERSION = 0.15;
const W_LOAD = 0.15;
// Expected job value: Probook-parity — dispatch prefers the tech likeliest to
// produce a high-value job, not just the nearest/most-skilled. Kept a MODEST
// weight (carved from conversion, its revenue-adjacent sibling) to avoid the
// cherry-pick / dispatcher-assigned-revenue-bias trap the review flagged.
const W_VALUE = 0.1;

const SKILL_DEPTH_CAP = 10; // jobs beyond this don't increase skill depth
const LOAD_CAP = 6; // same-day jobs beyond this don't increase the load penalty
const DEFAULT_RATING = 3.5; // assumed quality for a tech with no ratings yet
// Avg ticket at/above this ($1,500) maxes the value term; below scales linearly.
const REVENUE_CAP_CENTS = 150000;

// Travel overlay (applied only when travelKm is known). Location is primary per
// the dispatch spec, so a known travel distance carries the largest single
// weight; the existing skill/quality/conversion/load mix fills the remainder.
const W_TRAVEL = 0.45;
const TRAVEL_CAP_KM = 40; // beyond the service radius, travel score floors at 0
const TRAVEL_CAP_MIN = 45; // drive-time equivalent; beyond this the term floors at 0

// Empty availability → the same bounded default the coverage check uses
// (Mon–Fri 8:00–20:00 = 720 min). Kept in sync with availability-coverage.ts's
// DEFAULT_BUSINESS_DAY (module-local there; duplicated here as a constant to avoid
// importing a server-tz helper into the pure scorer).
const DEFAULT_DAY_MINUTES = 720;

/** Total working minutes across a tech's weekday slots (sum of endMinute −
 * startMinute). Empty → DEFAULT_DAY_MINUTES. Pure. */
export function sumAvailabilityMinutes(
  slots: readonly { readonly startMinute: number; readonly endMinute: number }[],
): number {
  if (slots.length === 0) return DEFAULT_DAY_MINUTES;
  return slots.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
}

// Fixed down-rank when the tech's booked minutes + this job likely overflow their
// working day. Down-rank ONLY — the hard gate stays placeAndAssignRequest's
// conflict/availability check.
const DURATION_FIT_PENALTY = 0.1;

/** A short label for the job's specialty, for human-readable reasons. */
/** Office words for the skill a reason names: "service call", never "service_call". */
function skillLabel(job: DispatchSignals['job']): string {
  if (job.jobType) return inSentence(jobTypeLabel(job.jobType));
  if (job.systemType) return inSentence(humanizeCode(job.systemType));
  return 'matching';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Neutral travel term for a candidate with NO location signal when OTHER
// candidates DO have one — treats unknown proximity as median rather than
// letting an unlocated tech keep the full composite and outrank located techs.
const NEUTRAL_TRAVEL_SCORE = 0.5;

export function scoreTechnician(
  signals: DispatchSignals,
  opts: { readonly travelRegimeActive?: boolean } = {},
): RankedTech {
  const { job, tech } = signals;
  const skillMatched = tech.skillJobsCompleted > 0;

  const skillDepth =
    Math.min(tech.skillJobsCompletedRecent, SKILL_DEPTH_CAP) / SKILL_DEPTH_CAP;
  const quality = Math.min((tech.avgRating ?? DEFAULT_RATING) / 5, 1);
  const conversion = Math.min(Math.max(tech.conversionRate, 0), 1);
  const load = 1 - Math.min(tech.sameDayJobCount, LOAD_CAP) / LOAD_CAP;
  const value =
    Math.min(Math.max(tech.avgJobRevenueCents, 0), REVENUE_CAP_CENTS) /
    REVENUE_CAP_CENTS;

  const composite =
    skillDepth * W_SKILL +
    quality * W_QUALITY +
    conversion * W_CONVERSION +
    load * W_LOAD +
    value * W_VALUE;

  // Travel overlay: known proximity dominates (location-primary). Prefer road
  // drive-time (minutes) when routing priced this tech; else the straight-line km;
  // absent both → the score equals the composite exactly (no-travel unchanged).
  let score = composite;
  let travelReason: string | null = null;
  if (tech.travelMinutes != null && Number.isFinite(tech.travelMinutes)) {
    const travelScore = Math.max(
      0,
      1 - Math.min(tech.travelMinutes, TRAVEL_CAP_MIN) / TRAVEL_CAP_MIN,
    );
    score = travelScore * W_TRAVEL + composite * (1 - W_TRAVEL);
    travelReason = `${Math.round(tech.travelMinutes)} min drive`;
  } else if (tech.travelKm != null && Number.isFinite(tech.travelKm)) {
    const travelScore = Math.max(
      0,
      1 - Math.min(tech.travelKm, TRAVEL_CAP_KM) / TRAVEL_CAP_KM,
    );
    score = travelScore * W_TRAVEL + composite * (1 - W_TRAVEL);
    travelReason = `${tech.travelKm.toFixed(1)} km away`;
  } else if (opts.travelRegimeActive) {
    // Regime active (some candidate has travel) but this tech has no location →
    // blend a neutral travel term so an unlocated tech is scored in the SAME
    // regime, not handed the full composite (which would systematically outrank
    // located techs — including a genuinely nearby one).
    score = NEUTRAL_TRAVEL_SCORE * W_TRAVEL + composite * (1 - W_TRAVEL);
    travelReason = "location unknown";
  }

  // Duration-fit down-rank: if the booked day plus this job overflows the working
  // window, the tech probably can't fit it — nudge them down (not a hard gate).
  let dayLikelyFull = false;
  if (tech.bookedMinutes + tech.thisJobEstimate > tech.dayMinutes) {
    score = Math.max(0, score - DURATION_FIT_PENALTY);
    dayLikelyFull = true;
  }

  const reasons: string[] = [];
  if (travelReason) {
    reasons.push(travelReason);
  }
  if (dayLikelyFull) reasons.push("day likely full");
  reasons.push(
    skillMatched
      ? `${plural(tech.skillJobsCompleted, `prior ${skillLabel(job)} request`, `prior ${skillLabel(job)} requests`)}`
      : `no prior ${skillLabel(job)} experience`,
  );
  if (tech.avgRating != null) reasons.push(`${tech.avgRating.toFixed(1)}★ rating`);
  if (tech.conversionRate > 0) reasons.push(`${Math.round(tech.conversionRate * 100)}% close rate`);
  if (tech.avgJobRevenueCents > 0) {
    reasons.push(`${formatCents(tech.avgJobRevenueCents)} avg ticket`);
  }
  reasons.push(plural(tech.sameDayJobCount, 'request that day', 'requests that day'));

  return {
    technicianId: tech.technicianId,
    score,
    reasons: reasons.map(sentenceCase),
    skillMatched,
    travelKm: tech.travelKm ?? null,
    travelMinutes: tech.travelMinutes ?? null,
  };
}

/**
 * Score every candidate, drop the non-skill-matched, and sort by score desc.
 * Ties break by technicianId (ascending) so the ordering is fully deterministic.
 *
 * Fallback (SUGGEST panel only): when `fallback` is true and NO candidate has
 * matching-category history (eligible is empty), rank ALL candidates rather than
 * returning an empty list, tagged "no matching-category history". Auto-assign
 * passes `fallback = false` so a classified job with no skill-matched tech returns
 * [] — the hard gate leaves it for a dispatcher (never auto-commit on no signal).
 */
export function rankTechnicians(
  candidates: readonly DispatchSignals[],
  fallback = true,
): RankedTech[] {
  // Only skill-matched candidates survive the ranking, so the travel regime must
  // be decided over THOSE — matching scoreTechnician's `skillMatched =
  // skillJobsCompleted > 0`. A candidate that gets filtered out must NOT activate
  // the regime: doing so applied the neutral-travel blend (a 0.55x compression of
  // every other signal) to the survivors and shrank the top-vs-second gap below
  // the auto-commit threshold — flipping a clear winner to queued_ambiguous.
  const eligible = candidates.filter((c) => c.tech.skillJobsCompleted > 0);

  // Fallback: if no tech has same-category history, rank everyone. The skill term
  // is zero for all, so quality/availability/travel still produce a meaningful
  // ordering. We tag the results so dispatchers know there's no prior-history
  // signal behind the ranking.
  // No skill-matched tech: suggest ranks everyone (fallback); auto-assign gets []
  // (pool stays empty) so the hard gate leaves the job for a human.
  const pool = eligible.length > 0 ? eligible : fallback ? candidates : [];
  const isFallback = eligible.length === 0 && candidates.length > 0 && fallback;

  // Single travel regime per ranking: if ANY pooled candidate has a location
  // signal, score the location-less ones with a neutral travel term so they can't
  // win just by escaping the travel blend the located candidates pay.
  const travelRegimeActive = pool.some(
    (c) =>
      (c.tech.travelMinutes != null && Number.isFinite(c.tech.travelMinutes)) ||
      (c.tech.travelKm != null && Number.isFinite(c.tech.travelKm)),
  );
  return pool
    .map((c) => {
      const ranked = scoreTechnician(c, { travelRegimeActive });
      if (isFallback) {
        // Prepend an honest label so the panel makes clear this is a fallback
        // ranking (no same-category jobs to go on).
        return {
          ...ranked,
          reasons: [
            sentenceCase("no matching history, so ranked on availability and travel"),
            ...ranked.reasons,
          ],
        };
      }
      return ranked;
    })
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.technicianId.localeCompare(b.technicianId),
    );
}

export type DispatchOutcome =
  | "committed"
  | "queued_ambiguous"
  | "queued_no_fit"
  | "queued_needs_review";

/** Minimum top-vs-second score gap to AUTO-COMMIT. A clear winner commits; a
 * near-tie is too close to auto-decide and goes to a human. Gap-based (not an
 * absolute threshold) so it's robust to the travel-present vs -absent score
 * regimes. Provisional — tune on pilot override-rate data. */
const MIN_CONFIDENCE_GAP = 0.08;
// Emergencies auto-commit on a much smaller gap: getting a qualified tech dispatched
// FAST beats waiting for a human to pick the perfect match on a near-tie. This is the
// Probook-parity "job priority" tier — an emergency jumps to auto-dispatch instead of
// sitting in the exception queue.
const EMERGENCY_MIN_CONFIDENCE_GAP = 0.02;

/**
 * Confidence-gated decision over an already-ranked (skill-matched, score-desc)
 * candidate list. Auto-commits ONLY when there's a clear best tech; otherwise it
 * defers to a human. Empty ranking (nobody skill-matched) → no-fit queue. For an
 * `emergency` job the gate is relaxed so a near-tie still auto-dispatches (speed
 * over the perfect match).
 */
export function classifyDispatch(
  ranked: readonly RankedTech[],
  urgency?: string,
): {
  readonly outcome: DispatchOutcome;
  readonly technicianId?: string;
} {
  if (ranked.length === 0) return { outcome: "queued_no_fit" };
  const top = ranked[0]!;
  const gap = ranked.length > 1 ? top.score - ranked[1]!.score : Infinity;
  const minGap =
    urgency === "emergency"
      ? EMERGENCY_MIN_CONFIDENCE_GAP
      : MIN_CONFIDENCE_GAP;
  if (gap >= minGap) {
    return { outcome: "committed", technicianId: top.technicianId };
  }
  return { outcome: "queued_ambiguous" };
}
