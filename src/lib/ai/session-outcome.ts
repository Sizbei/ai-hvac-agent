/**
 * Stage 3 — AI conversation summary + outcome classification.
 *
 * After a conversation closes (booked / escalated / abandoned) an after() pass
 * runs an economy-tier LLM over the transcript and writes a manager-facing
 * `summary`, a classified `outcome`, and `nextSteps` onto the session. Uniform
 * across chat AND voice (both share customer_sessions).
 *
 * The summary is labeled AI-generated and instructed to avoid raw PII; it is
 * NEVER written to the audit log (which is PII-free by contract).
 */
import { generateText } from "ai";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { getExtractionModel } from "./provider";
import { logger } from "@/lib/logger";

export type SessionOutcome =
  | "booked"
  | "escalated"
  | "info_provided"
  | "abandoned"
  | "unresolved";

const OUTCOMES: readonly SessionOutcome[] = [
  "booked",
  "escalated",
  "info_provided",
  "abandoned",
  "unresolved",
];

const SYSTEM = `You write a brief manager-facing recap of a completed HVAC customer-service conversation. Output ONLY a JSON object, no prose, no code fences:
{"summary": "2-3 sentence recap; refer to 'the customer', do NOT include full address, phone, or email", "outcome": "one of: booked | escalated | info_provided | abandoned | unresolved", "nextSteps": ["0-3 short action items for staff"]}`;

/** Tolerant JSON extraction from a model response (handles stray prose/fences). */
function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Minimum user turns for a session to be worth an LLM summary pass. */
const MIN_TURNS_FOR_SUMMARY = 1;

/**
 * Summarize + classify a closed session and persist it. Best-effort: any
 * failure is logged and swallowed (this runs in after(), never on the response
 * path). `definiteOutcome` lets the caller pin a known outcome (booked from the
 * submit path, escalated from the escalation path); the LLM only fills it in
 * when the caller doesn't know (e.g. the abandoned-sweep cron).
 */
export async function summarizeAndClassifySession(params: {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly definiteOutcome?: SessionOutcome;
}): Promise<void> {
  const { organizationId, sessionId, definiteOutcome } = params;
  try {
    const turns = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(withTenant(messages, organizationId, eq(messages.sessionId, sessionId)))
      .orderBy(asc(messages.createdAt));

    const convo = turns
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
      .join("\n")
      // Cap the transcript so a very long session can't blow the model context
      // window (keep the most recent ~12k chars — the tail carries the outcome).
      .slice(-12000);

    const userTurns = turns.filter((m) => m.role === "user").length;
    if (userTurns < MIN_TURNS_FOR_SUMMARY) {
      // Trivial/empty session — record only the definite outcome, skip the LLM.
      if (definiteOutcome) {
        await persist(organizationId, sessionId, null, definiteOutcome, []);
      }
      return;
    }

    const { text } = await generateText({
      model: getExtractionModel(),
      system: SYSTEM,
      messages: [{ role: "user", content: convo }],
    });

    const parsed = parseJson(text) ?? {};
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.slice(0, 1000) : null;
    const llmOutcome =
      typeof parsed.outcome === "string" &&
      (OUTCOMES as readonly string[]).includes(parsed.outcome)
        ? (parsed.outcome as SessionOutcome)
        : undefined;
    const outcome: SessionOutcome =
      definiteOutcome ?? llmOutcome ?? "unresolved";
    const nextSteps = Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.filter((s): s is string => typeof s === "string").slice(0, 3)
      : [];

    await persist(organizationId, sessionId, summary, outcome, nextSteps);
  } catch (error) {
    logger.error({ error, sessionId }, "Session summary/classify failed (non-fatal)");
  }
}

async function persist(
  organizationId: string,
  sessionId: string,
  summary: string | null,
  outcome: SessionOutcome,
  nextSteps: string[],
): Promise<void> {
  await db
    .update(customerSessions)
    .set({ summary, outcome, nextSteps, updatedAt: new Date() })
    .where(
      withTenant(customerSessions, organizationId, eq(customerSessions.id, sessionId)),
    );
}
