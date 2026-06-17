/**
 * Bot turn telemetry (CHATBOT-PLAN Step 10 prerequisite).
 *
 * recordBotEvent persists ONE PII-free `bot_events` row per resolved chat turn —
 * the routing/outcome signals the chat route already computes (deterministic-vs-
 * LLM, intent, action, category, completion, escalation, model, latency). This is
 * the aggregatable record behind the Insights "Bot analytics" section.
 *
 * BEST-EFFORT: this is called from after() on the chat route and MUST never throw
 * or slow a customer turn. Every failure is logged and swallowed — a telemetry
 * blip can never affect the reply that already streamed.
 *
 * PII CONTRACT: callers pass ids/enums/flags/numbers ONLY. Never message text,
 * never customer data.
 */
import { db } from "@/lib/db";
import { botEvents } from "@/lib/db/schema";
import { KNOWLEDGE_BASE } from "./knowledge-base";
import { logger } from "@/lib/logger";

export interface BotEventInput {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly channel: string;
  /** true = deterministic router handled the turn; false = LLM fallback. */
  readonly routed: boolean;
  readonly intentId?: string | null;
  readonly action?: string | null;
  readonly extractionComplete?: boolean;
  readonly escalated?: boolean;
  /** Resolved model id for an LLM turn; null/undefined on a deterministic turn. */
  readonly model?: string | null;
  readonly latencyMs?: number | null;
}

/** Resolve the knowledge-base category for an intent id, null when unknown. */
function categoryForIntent(intentId: string | null | undefined): string | null {
  if (!intentId) return null;
  return KNOWLEDGE_BASE.find((e) => e.id === intentId)?.category ?? null;
}

/**
 * Persist a single bot turn telemetry row. Best-effort: never throws.
 */
export async function recordBotEvent(input: BotEventInput): Promise<void> {
  try {
    await db.insert(botEvents).values({
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      turn: input.turn,
      channel: input.channel,
      routed: input.routed,
      intentId: input.intentId ?? null,
      action: input.action ?? null,
      category: categoryForIntent(input.intentId),
      extractionComplete: input.extractionComplete ?? false,
      escalated: input.escalated ?? false,
      model: input.model ?? null,
      latencyMs: input.latencyMs ?? null,
    });
  } catch (error) {
    // Telemetry is non-critical — log and move on. Never bubble to the turn.
    logger.error(
      { error, sessionId: input.sessionId },
      "recordBotEvent failed (non-fatal)",
    );
  }
}
