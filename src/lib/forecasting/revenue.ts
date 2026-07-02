/**
 * Rung A revenue forecaster — pure, deterministic, no I/O. Three streams form a
 * STRICT PARTITION with precedence so they can be summed without double-counting:
 *   1. booked/scheduled (by serviceRequestId)
 *   2. pipeline = open estimates NOT already consumed by a booked job
 *   3. recurring (MRR) for periods NOT already materialized into a booked job
 * Pipeline uses a single age-conditional close probability (no separate age-decay
 * multiplier → no double-discount); conversion mass beyond the horizon is simply
 * not added. (Probook v3 §6.2.3.)
 */

export interface BookedJob {
  readonly serviceRequestId: string;
  readonly estimateId: string | null;
  readonly cents: number;
}

export interface OpenEstimate {
  readonly estimateId: string;
  readonly serviceRequestId: string | null;
  readonly totalCents: number;
  readonly ageDays: number;
}

export interface MrrPeriod {
  readonly key: string;
  readonly materializedServiceRequestId: string | null;
  readonly cents: number;
}

export interface RevenueForecast {
  readonly bookedCents: number;
  readonly pipelineCents: number;
  readonly mrrCents: number;
  readonly totalCents: number;
}

const clamp01 = (n: number): number => Math.min(Math.max(n, 0), 1);

/**
 * @param closeProbWithinHorizon P(converts within [now, now+horizon] | survived to ageDays),
 *   read directly off the empirical survival curve — a single conditional quantity in [0,1].
 */
export function forecastRevenue(input: {
  readonly booked: readonly BookedJob[];
  readonly openEstimates: readonly OpenEstimate[];
  readonly mrr: readonly MrrPeriod[];
  readonly closeProbWithinHorizon: (ageDays: number) => number;
}): RevenueForecast {
  const bookedEstimateIds = new Set(
    input.booked.map((b) => b.estimateId).filter((x): x is string => x != null),
  );
  const bookedReqIds = new Set(input.booked.map((b) => b.serviceRequestId));

  const bookedCents = input.booked.reduce((s, b) => s + b.cents, 0);

  // Pipeline excludes estimates already consumed by a booked job (by estimateId
  // or by the booked job's serviceRequestId).
  const pipelineCents = input.openEstimates
    .filter(
      (e) =>
        !bookedEstimateIds.has(e.estimateId) &&
        !(e.serviceRequestId != null && bookedReqIds.has(e.serviceRequestId)),
    )
    .reduce(
      (s, e) => s + Math.round(e.totalCents * clamp01(input.closeProbWithinHorizon(e.ageDays))),
      0,
    );

  // MRR excludes periods already materialized into a booked job.
  const mrrCents = input.mrr
    .filter(
      (m) =>
        !(m.materializedServiceRequestId != null && bookedReqIds.has(m.materializedServiceRequestId)),
    )
    .reduce((s, m) => s + m.cents, 0);

  return {
    bookedCents,
    pipelineCents,
    mrrCents,
    totalCents: bookedCents + pipelineCents + mrrCents,
  };
}

/**
 * Dev/test guard — covers the SAME dimensions forecastRevenue excludes on
 * (estimateId AND serviceRequestId AND MRR's materialized request). Throws if any
 * entity appears in two streams.
 */
export function assertDisjoint(input: {
  readonly booked: readonly BookedJob[];
  readonly openEstimates: readonly OpenEstimate[];
  readonly mrr: readonly MrrPeriod[];
}): void {
  const bookedEst = new Set(
    input.booked.map((b) => b.estimateId).filter((x): x is string => x != null),
  );
  const bookedReq = new Set(input.booked.map((b) => b.serviceRequestId));
  for (const e of input.openEstimates) {
    if (bookedEst.has(e.estimateId)) {
      throw new Error(`estimate ${e.estimateId} counted in both booked and pipeline`);
    }
    if (e.serviceRequestId != null && bookedReq.has(e.serviceRequestId)) {
      throw new Error(
        `estimate ${e.estimateId} (req ${e.serviceRequestId}) overlaps a booked job`,
      );
    }
  }
  for (const m of input.mrr) {
    if (m.materializedServiceRequestId != null && bookedReq.has(m.materializedServiceRequestId)) {
      throw new Error(`MRR period ${m.key} overlaps a booked materialized visit`);
    }
  }
}
