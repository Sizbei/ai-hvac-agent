/**
 * Database query functions for the admin "AI Insights" dashboard.
 *
 * Every metric is computed from EXISTING tables (customer_sessions, messages,
 * service_requests, audit_log) — there is no dedicated metrics table and no
 * schema change. Each query is tenant-scoped via withTenant (multi-tenancy
 * contract).
 *
 * NOTE: the neon-http driver returns SQL aggregates (count, sum) as strings, so
 * every aggregate value is coerced with Number() before use.
 */
import { eq, sql, count, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  serviceRequests,
  auditLog,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { AiInsights } from "./ai-insights-types";

/** Coerce a possibly-string aggregate value (neon-http) to a finite number. */
function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A rate as a 0-100 whole number; 0 when the denominator is 0. */
function asPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 100);
}

export async function getAiInsights(
  organizationId: string,
): Promise<AiInsights> {
  // All 9 queries are independent — run them in parallel to cut 9 serial
  // round-trips down to 1 concurrent batch.
  const [
    [totalSessionsRow],
    [escalatedRow],
    [abandonedRow],
    [submittedRow],
    [deterministicRow],
    [llmRow],
    [tokensRow],
    [feedbackUpRow],
    [feedbackDownRow],
  ] = await Promise.all([
    // Session counts (total + per-status).
    db
      .select({ value: count() })
      .from(customerSessions)
      .where(withTenant(customerSessions, organizationId)),

    db
      .select({ value: count() })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          eq(customerSessions.status, "escalated"),
        ),
      ),

    db
      .select({ value: count() })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          eq(customerSessions.status, "abandoned"),
        ),
      ),

    // Submitted service requests.
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId)),

    // Assistant reply breakdown: 0-token (deterministic router) vs LLM (>0).
    db
      .select({ value: count() })
      .from(messages)
      .where(
        withTenant(
          messages,
          organizationId,
          eq(messages.role, "assistant"),
          eq(messages.tokensUsed, 0),
        ),
      ),

    db
      .select({ value: count() })
      .from(messages)
      .where(
        withTenant(
          messages,
          organizationId,
          eq(messages.role, "assistant"),
          gt(messages.tokensUsed, 0),
        ),
      ),

    // Total tokens consumed across all messages (null → 0).
    db
      .select({
        value: sql<number | string>`coalesce(sum(${messages.tokensUsed}), 0)`,
      })
      .from(messages)
      .where(withTenant(messages, organizationId)),

    // Message feedback votes from the audit log (details is a JSON TEXT column).
    db
      .select({ value: count() })
      .from(auditLog)
      .where(
        withTenant(
          auditLog,
          organizationId,
          eq(auditLog.action, "message_feedback"),
          sql`${auditLog.details} LIKE ${'%"vote":"up"%'}`,
        ),
      ),

    db
      .select({ value: count() })
      .from(auditLog)
      .where(
        withTenant(
          auditLog,
          organizationId,
          eq(auditLog.action, "message_feedback"),
          sql`${auditLog.details} LIKE ${'%"vote":"down"%'}`,
        ),
      ),
  ]);

  const totalSessions = toNumber(totalSessionsRow?.value);
  const submittedRequests = toNumber(submittedRow?.value);
  const escalatedSessions = toNumber(escalatedRow?.value);
  const abandonedSessions = toNumber(abandonedRow?.value);
  const deterministicReplies = toNumber(deterministicRow?.value);
  const llmReplies = toNumber(llmRow?.value);
  const totalTokensUsed = toNumber(tokensRow?.value);
  const feedbackUp = toNumber(feedbackUpRow?.value);
  const feedbackDown = toNumber(feedbackDownRow?.value);

  return {
    totalSessions,
    submittedRequests,
    escalatedSessions,
    abandonedSessions,
    deterministicReplies,
    llmReplies,
    deflectionRate: asPercent(
      deterministicReplies,
      deterministicReplies + llmReplies,
    ),
    totalTokensUsed,
    feedbackUp,
    feedbackDown,
    conversionRate: asPercent(submittedRequests, totalSessions),
  };
}
