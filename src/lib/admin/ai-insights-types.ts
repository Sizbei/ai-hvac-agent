/**
 * Admin "AI Insights" dashboard types.
 *
 * All metrics are derived from EXISTING tables (customer_sessions, messages,
 * service_requests, audit_log) — no schema changes. Every value is a number;
 * rates are expressed as a whole-number 0-100 percentage.
 *
 * All properties are readonly for immutability.
 */

export interface AiInsights {
  readonly totalSessions: number;
  readonly submittedRequests: number;
  readonly escalatedSessions: number;
  readonly abandonedSessions: number;
  /** Assistant turns answered with no LLM call (tokensUsed = 0). */
  readonly deterministicReplies: number;
  /** Assistant turns that consumed LLM tokens (tokensUsed > 0). */
  readonly llmReplies: number;
  /** deterministic / (deterministic + llm), as a 0-100 whole number. */
  readonly deflectionRate: number;
  readonly totalTokensUsed: number;
  readonly feedbackUp: number;
  readonly feedbackDown: number;
  /** submittedRequests / totalSessions, as a 0-100 whole number. */
  readonly conversionRate: number;
}
