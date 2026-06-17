/**
 * Database-touching orchestration for conversation compaction.
 *
 * Kept separate from compaction.ts (which stays pure/model-only) so the model
 * helpers test without a DB. This module re-reads the current running summary,
 * folds the overflow turns into it, and persists the result — designed to run
 * inside a `next/server` after() background task on both the chat and voice
 * paths.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import {
  shouldCompact,
  selectTurnsToCompact,
  summarizeOlderTurns,
  type ChatTurn,
} from "./compaction";

/**
 * Roll the turns that have aged out of the recent window into the session's
 * running summary, if the conversation is long enough to warrant it.
 *
 * Re-reads the CURRENT running summary (not a request-time snapshot) so a
 * concurrent compaction's result is carried forward rather than clobbered.
 * Scopes the write by id AND org (defense in depth, matching the chat route).
 * Returns true when a new summary was written.
 */
export async function compactSessionIfNeeded(params: {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly history: readonly ChatTurn[];
}): Promise<boolean> {
  const { sessionId, organizationId, history } = params;

  if (!shouldCompact(history.length)) {
    return false;
  }

  const olderTurns = selectTurnsToCompact(history);
  if (olderTurns.length === 0) {
    return false;
  }

  const [fresh] = await db
    .select({ runningSummary: customerSessions.runningSummary })
    .from(customerSessions)
    .where(
      and(
        eq(customerSessions.id, sessionId),
        eq(customerSessions.organizationId, organizationId),
      ),
    )
    .limit(1);

  const priorSummary = fresh?.runningSummary ?? null;

  const nextSummary = await summarizeOlderTurns({
    priorSummary,
    olderTurns,
    organizationId,
  });

  // Nothing meaningful changed (model returned the same text or fell back to
  // the prior summary) — skip the write.
  if (nextSummary === (priorSummary ?? "") || nextSummary === priorSummary) {
    return false;
  }

  await db
    .update(customerSessions)
    .set({ runningSummary: nextSummary, updatedAt: new Date() })
    .where(
      and(
        eq(customerSessions.id, sessionId),
        eq(customerSessions.organizationId, organizationId),
      ),
    );

  return true;
}
