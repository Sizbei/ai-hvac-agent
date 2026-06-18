/**
 * CHATBOT-PLAN Step 10 — intent / outcome analytics.
 *
 * Read-only aggregates over the `bot_events` turn-telemetry table (per-turn
 * routing signals) joined with the `customer_sessions` outcome classification
 * (post-hoc booked/escalated/abandoned). Every aggregate is tenant-scoped via
 * withTenant — a cross-org count is a tenant breach — and period-scoped to a
 * date range (defaults to the last 30 days).
 *
 * neon-http note: SQL aggregates (count/avg) come back as strings (or null for
 * an empty set), so each value is coerced with Number() and coalesced to 0.
 */
import { eq, gte, lte, sql, count, avg, isNotNull, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { botEvents, customerSessions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface BotAnalyticsPeriod {
  readonly fromDate?: Date;
  readonly toDate?: Date;
}

export interface IntentDistributionRow {
  /** The router intent id, or "unknown" for turns with no winning intent. */
  readonly intentId: string;
  readonly count: number;
}

export interface OutcomeDistributionRow {
  /** A sessionOutcomeEnum value, or "unclassified" for sessions with no outcome. */
  readonly outcome: string;
  readonly count: number;
}

export interface BotAnalytics {
  readonly fromDate: string;
  readonly toDate: string;
  /** Total bot turns (bot_events rows) in the period. */
  readonly totalTurns: number;
  /** routed=true / total, 0-1, rounded to 3dp. 0 when no turns. */
  readonly deterministicRatio: number;
  /** Top intents by turn count (descending), capped. Excludes null-intent turns. */
  readonly intentDistribution: readonly IntentDistributionRow[];
  /** escalated turns / total, 0-1, rounded to 3dp. 0 when no turns. */
  readonly escalationRate: number;
  /** extractionComplete turns / total, 0-1, rounded to 3dp. 0 when no turns. */
  readonly extractionCompletionRate: number;
  /**
   * Turns where the bot answered a general HVAC question (the helpful-first
   * capability) rather than running deterministic intake — tagged on the
   * LLM-fallback path as action='knowledge'. / total, 0-1, 3dp.
   */
  readonly knowledgeAnswerRate: number;
  /** Avg latencyMs across turns that recorded a latency, or null when none. */
  readonly avgLatencyMs: number | null;
  /** Sessions classified "abandoned" / sessions with ANY outcome, 0-1, 3dp. */
  readonly abandonRate: number;
  /** Per-outcome session counts (descending). Includes an "unclassified" bucket. */
  readonly outcomeDistribution: readonly OutcomeDistributionRow[];
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ratio rounded to 3 decimal places; 0 when the denominator is 0. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Max intents surfaced in the distribution table. */
const TOP_INTENTS = 12;
/** Bucket key for a NULL intent / NULL outcome. */
const UNKNOWN_INTENT = "unknown";
const UNCLASSIFIED_OUTCOME = "unclassified";

/**
 * Compute an org's bot analytics for a period. Defaults to the last 30 days when
 * no range is given. All ratios are 0-1 floats; the UI formats as percentages.
 */
export async function getBotAnalytics(
  organizationId: string,
  period: BotAnalyticsPeriod = {},
): Promise<BotAnalytics> {
  const now = new Date();
  const toDate = period.toDate ?? now;
  const fromDate =
    period.fromDate ?? new Date(toDate.getTime() - THIRTY_DAYS_MS);

  const [totalsRow, intentRows, outcomeRows] = await Promise.all([
    // Turn-level rollup in ONE pass: total, deterministic, escalated, complete,
    // and avg latency. count(CASE …) counts only matching rows; avg ignores NULL
    // latencies (an honest avg over measured turns).
    db
      .select({
        total: count(),
        deterministic: count(
          sql`CASE WHEN ${botEvents.routed} = true THEN 1 END`,
        ),
        escalated: count(
          sql`CASE WHEN ${botEvents.escalated} = true THEN 1 END`,
        ),
        complete: count(
          sql`CASE WHEN ${botEvents.extractionComplete} = true THEN 1 END`,
        ),
        // General-knowledge answers (helpful-first capability) are tagged
        // action='knowledge' on the LLM-fallback path (deterministic turns carry
        // a real router action, so this never double-counts intake).
        knowledgeAnswers: count(
          sql`CASE WHEN ${botEvents.action} = 'knowledge' THEN 1 END`,
        ),
        avgLatency: avg(botEvents.latencyMs),
      })
      .from(botEvents)
      .where(
        withTenant(
          botEvents,
          organizationId,
          gte(botEvents.createdAt, fromDate),
          lte(botEvents.createdAt, toDate),
        ),
      ),

    // Intent distribution: turns grouped by intent id, top N by count. Only turns
    // that HAVE a winning intent (deterministic, non-SLOT_FILL) — null-intent
    // turns (LLM fallback, slot fills) are excluded so the table reads cleanly.
    db
      .select({ intentId: botEvents.intentId, value: count() })
      .from(botEvents)
      .where(
        withTenant(
          botEvents,
          organizationId,
          isNotNull(botEvents.intentId),
          gte(botEvents.createdAt, fromDate),
          lte(botEvents.createdAt, toDate),
        ),
      )
      .groupBy(botEvents.intentId)
      .orderBy(desc(count()))
      .limit(TOP_INTENTS),

    // Outcome distribution: sessions grouped by classified outcome. NULL outcome
    // -> "unclassified" so still-open / never-summarized sessions reconcile.
    db
      .select({
        outcome: sql<string>`coalesce(${customerSessions.outcome}, ${UNCLASSIFIED_OUTCOME})`,
        value: count(),
      })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          gte(customerSessions.createdAt, fromDate),
          lte(customerSessions.createdAt, toDate),
        ),
      )
      .groupBy(sql`coalesce(${customerSessions.outcome}, ${UNCLASSIFIED_OUTCOME})`),
  ]);

  const totals = totalsRow[0];
  const totalTurns = toNumber(totals?.total);
  const deterministic = toNumber(totals?.deterministic);
  const escalated = toNumber(totals?.escalated);
  const complete = toNumber(totals?.complete);
  const knowledgeAnswers = toNumber(totals?.knowledgeAnswers);
  // avg() returns null for an empty/all-NULL set — keep null (honest "—").
  const avgLatencyMs =
    totals?.avgLatency == null
      ? null
      : Math.round(Number(totals.avgLatency));

  const intentDistribution: IntentDistributionRow[] = intentRows.map((r) => ({
    intentId: r.intentId ?? UNKNOWN_INTENT,
    count: toNumber(r.value),
  }));

  const outcomeDistribution: OutcomeDistributionRow[] = outcomeRows
    .map((r) => ({ outcome: r.outcome, count: toNumber(r.value) }))
    .sort((a, b) => b.count - a.count);

  // Abandon rate is over sessions that reached SOME classified outcome (a fair
  // denominator: still-open sessions aren't "not abandoned", they're undecided).
  const classifiedSessions = outcomeDistribution
    .filter((r) => r.outcome !== UNCLASSIFIED_OUTCOME)
    .reduce((sum, r) => sum + r.count, 0);
  const abandonedSessions =
    outcomeDistribution.find((r) => r.outcome === "abandoned")?.count ?? 0;

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    totalTurns,
    deterministicRatio: ratio(deterministic, totalTurns),
    intentDistribution,
    escalationRate: ratio(escalated, totalTurns),
    extractionCompletionRate: ratio(complete, totalTurns),
    knowledgeAnswerRate: ratio(knowledgeAnswers, totalTurns),
    avgLatencyMs,
    abandonRate: ratio(abandonedSessions, classifiedSessions),
    outcomeDistribution,
  };
}
