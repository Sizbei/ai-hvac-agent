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
import { and, eq, exists, not, notExists, sql, count, gt, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  serviceRequests,
  auditLog,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { notStandInSession } from "./stand-in-session";
import { visibleRows, type Visibility } from "./visibility";
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

/** A feedback vote not cast in a session the viewer can't see (votes with no session count). */
function feedbackSessionVisible(organizationId: string, vis: Visibility): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.id, auditLog.sessionId),
          eq(customerSessions.organizationId, organizationId),
          not(visibleRows(customerSessions, vis)),
        ),
      ),
  );
}

/**
 * Assistant metrics over the conversations the viewer sees: sessions and
 * requests by their own flag, messages through their session.
 */
export async function getAiInsights(
  organizationId: string,
  vis: Visibility,
): Promise<AiInsights> {
  // All 9 queries are independent — run them in a single db.batch to cut 9
  // serial round-trips down to 1 HTTP request.
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
  ] = await db.batch([
    // Session counts (total + per-status). Stand-in sessions (office
    // bookings, membership visits, FieldPulse import) are not conversations.
    db
      .select({ value: count() })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          notStandInSession(customerSessions.token),
          visibleRows(customerSessions, vis),
        ),
      ),

    db
      .select({ value: count() })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          eq(customerSessions.status, "escalated"),
          notStandInSession(customerSessions.token),
          visibleRows(customerSessions, vis),
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
          notStandInSession(customerSessions.token),
          visibleRows(customerSessions, vis),
        ),
      ),

    // Submitted service requests that came from a real conversation, so the
    // conversion rate is conversation-booked / conversations.
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          exists(
            db
              .select({ one: sql`1` })
              .from(customerSessions)
              .where(
                and(
                  eq(customerSessions.id, serviceRequests.sessionId),
                  notStandInSession(customerSessions.token),
                  visibleRows(customerSessions, vis),
                ),
              ),
          ),
          visibleRows(serviceRequests, vis),
        ),
      ),

    // Assistant reply breakdown: 0-token (deterministic router) vs LLM (>0).
    db
      .select({ value: count() })
      .from(messages)
      .innerJoin(
        customerSessions,
        and(
          eq(customerSessions.id, messages.sessionId),
          eq(customerSessions.organizationId, organizationId),
          visibleRows(customerSessions, vis),
        ),
      )
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
      .innerJoin(
        customerSessions,
        and(
          eq(customerSessions.id, messages.sessionId),
          eq(customerSessions.organizationId, organizationId),
          visibleRows(customerSessions, vis),
        ),
      )
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
      .innerJoin(
        customerSessions,
        and(
          eq(customerSessions.id, messages.sessionId),
          eq(customerSessions.organizationId, organizationId),
          visibleRows(customerSessions, vis),
        ),
      )
      .where(withTenant(messages, organizationId)),

    // Message feedback votes from the audit log (details is a JSON TEXT column),
    // minus votes cast in a session the viewer doesn't see.
    db
      .select({ value: count() })
      .from(auditLog)
      .where(
        withTenant(
          auditLog,
          organizationId,
          eq(auditLog.action, "message_feedback"),
          sql`${auditLog.details} LIKE ${'%"vote":"up"%'}`,
          feedbackSessionVisible(organizationId, vis),
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
          feedbackSessionVisible(organizationId, vis),
        ),
      ),
  ] as const);

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
