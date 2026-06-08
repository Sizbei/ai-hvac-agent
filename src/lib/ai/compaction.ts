/**
 * Long-conversation compaction.
 *
 * The chat/voice model only ever sees a bounded sliding window of recent turns
 * (MAX_HISTORY) plus a rolling natural-language SUMMARY of everything older. As
 * a conversation grows past the window, the oldest turns are folded into that
 * running summary by a background task — so a 40-turn intake stays coherent
 * (the address mentioned on turn 2 survives) without re-sending the whole
 * transcript on every turn.
 *
 * These helpers are deliberately pure / model-only so they unit-test without a
 * database. The chat route owns persistence (writing `running_summary`).
 */
import { generateText } from "ai";
import { getExtractionModel } from "./provider";

export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

// Number of most-recent turns sent verbatim to the model. Matches the window
// the chat/extraction paths already used; kept here so compaction and the
// request builder agree on the boundary.
export const MAX_HISTORY = 10;

// Once a conversation exceeds this many stored messages, the background task
// rolls the overflow into the running summary. Set a few turns above
// MAX_HISTORY so we don't summarize on every single turn near the boundary.
export const COMPACTION_THRESHOLD = MAX_HISTORY + 4;

/** True once the stored message count warrants folding older turns into the summary. */
export function shouldCompact(messageCount: number): boolean {
  return messageCount > COMPACTION_THRESHOLD;
}

/**
 * The turns that have aged OUT of the recent window — everything before the
 * last MAX_HISTORY messages. These are the turns to fold into the summary.
 */
export function selectTurnsToCompact(
  history: readonly ChatTurn[],
): readonly ChatTurn[] {
  if (history.length <= MAX_HISTORY) return [];
  return history.slice(0, history.length - MAX_HISTORY);
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Assemble the message list sent to the model: an optional system "summary of
 * earlier conversation" turn, then the recent window, then the current user
 * message. Pure — no model call.
 */
export function buildModelMessages(params: {
  readonly runningSummary: string | null | undefined;
  readonly recent: readonly ChatTurn[];
  readonly current: string;
}): readonly ModelMessage[] {
  const { runningSummary, recent, current } = params;
  const messages: ModelMessage[] = [];

  if (hasText(runningSummary)) {
    messages.push({
      role: "system",
      content: `Summary of earlier conversation: ${runningSummary.trim()}`,
    });
  }

  for (const turn of recent) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: "user", content: current });
  return messages;
}

const SUMMARY_SYSTEM = `You maintain a running summary of an HVAC customer-service call so a later turn can recall earlier details without the full transcript. Given the prior summary and the next batch of conversation turns, output a single concise paragraph (no markdown, no preamble) that preserves every concrete fact: the customer's name, the issue, urgency, the service address, phone, email, and any commitments made. Drop pleasantries. Output ONLY the updated summary text.`;

function renderTurns(turns: readonly ChatTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.content}`)
    .join("\n");
}

/**
 * Fold `olderTurns` into `priorSummary`, returning the new running summary.
 * Idempotent in spirit: the prior summary is always carried forward, so a fact
 * captured once is never lost on a later compaction. Degrades to the prior
 * summary if the model returns nothing usable, and short-circuits (no model
 * call) when there's nothing new to summarize.
 */
export async function summarizeOlderTurns(params: {
  readonly priorSummary: string | null | undefined;
  readonly olderTurns: readonly ChatTurn[];
}): Promise<string> {
  const prior = hasText(params.priorSummary) ? params.priorSummary.trim() : "";

  if (params.olderTurns.length === 0) {
    return prior;
  }

  const userPrompt = `Prior summary:\n${prior || "(none yet)"}\n\nNew conversation turns to fold in:\n${renderTurns(
    params.olderTurns,
  )}`;

  const { text } = await generateText({
    model: getExtractionModel(),
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  });

  const next = typeof text === "string" ? text.trim() : "";
  return next.length > 0 ? next : prior;
}
