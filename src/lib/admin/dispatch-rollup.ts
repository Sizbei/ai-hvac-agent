/**
 * Dispatch outcome rollup — counts by outcome over the last `days`, split into
 * REAL (is_shadow=false) and SHADOW (is_shadow=true), plus the override count and
 * a combined commit rate (committed / total over real+shadow together). Pure read;
 * tenant-scoped. Feeds the Operations "Dispatch health" card and the weekly canary.
 *
 * Commit rate spans real+shadow deliberately: shadow exercises the same
 * geocode/signal/weight pipeline, so a shadow collapse signals the same breakage,
 * and autopilot-off orgs would otherwise never have a signal to alert on.
 */
import { and, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchOutcomeCounts {
  readonly committed: number;
  readonly queuedAmbiguous: number;
  readonly queuedNoFit: number;
  readonly queuedNeedsReview: number;
  readonly total: number;
}

export interface DispatchOutcomeRollup {
  readonly days: number;
  readonly real: DispatchOutcomeCounts;
  readonly shadow: DispatchOutcomeCounts;
  readonly overrides: number;
  /** committed / total over real+shadow combined; null when there are no decisions. */
  readonly commitRate: number | null;
}

const EMPTY: DispatchOutcomeCounts = {
  committed: 0,
  queuedAmbiguous: 0,
  queuedNoFit: 0,
  queuedNeedsReview: 0,
  total: 0,
};

function bump(
  counts: DispatchOutcomeCounts,
  outcome: string,
  n: number,
): DispatchOutcomeCounts {
  const total = counts.total + n;
  switch (outcome) {
    case "committed":
      return { ...counts, committed: counts.committed + n, total };
    case "queued_ambiguous":
      return { ...counts, queuedAmbiguous: counts.queuedAmbiguous + n, total };
    case "queued_no_fit":
      return { ...counts, queuedNoFit: counts.queuedNoFit + n, total };
    case "queued_needs_review":
      return {
        ...counts,
        queuedNeedsReview: counts.queuedNeedsReview + n,
        total,
      };
    default:
      return { ...counts, total };
  }
}

export async function getDispatchOutcomeRollup(
  organizationId: string,
  days: number,
): Promise<DispatchOutcomeRollup> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [grouped, overrideRows] = await Promise.all([
    db
      .select({
        outcome: dispatchDecisions.outcome,
        isShadow: dispatchDecisions.isShadow,
        n: sql<number>`count(*)`,
      })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          gte(dispatchDecisions.createdAt, since),
        ),
      )
      .groupBy(dispatchDecisions.outcome, dispatchDecisions.isShadow),
    db
      .select({ n: sql<number>`count(*)` })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            gte(dispatchDecisions.createdAt, since),
            // Spec-canonical override signal: the stamped human pick. (Always
            // co-written with overriddenAt today, but the tech id is the label.)
            isNotNull(dispatchDecisions.overriddenTechnicianId),
          )!,
        ),
      ),
  ]);

  let real = EMPTY;
  let shadow = EMPTY;
  for (const row of grouped) {
    const n = Number(row.n);
    if (row.isShadow) shadow = bump(shadow, row.outcome, n);
    else real = bump(real, row.outcome, n);
  }

  const combinedTotal = real.total + shadow.total;
  const combinedCommitted = real.committed + shadow.committed;
  const commitRate =
    combinedTotal > 0 ? combinedCommitted / combinedTotal : null;

  return {
    days,
    real,
    shadow,
    overrides: Number(overrideRows[0]?.n ?? 0),
    commitRate,
  };
}
