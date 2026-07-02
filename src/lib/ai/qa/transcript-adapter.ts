/**
 * Adapter: real conversation transcript (interleaved role/content `messages`) →
 * the LLM judge's index-aligned input (`userTurns[]` + a parallel `botReplies[]`,
 * where the judge renders each pair as "Customer: … / Bot: …"). PURE, no I/O —
 * the Stage-6 wiring (Avoca QA) feeds the output to `judgeTranscript`.
 *
 * Robust to non-alternating transcripts (the judge's zip assumes alternation):
 *  - consecutive assistant messages are concatenated into the preceding turn's reply;
 *  - consecutive user messages each get their own turn (null reply where none followed);
 *  - a leading assistant message (greeting before any caller turn) is dropped — the
 *    judge's model is customer-first; greeting presence is checked separately (Stage 8);
 *  - system messages are dropped.
 * Guarantees `userTurns.length === botReplies.length`.
 */

export type TranscriptRole = "user" | "assistant" | "system";

export interface ConversationMessage {
  readonly role: TranscriptRole;
  readonly content: string;
}

export interface JudgeReadyTranscript {
  readonly description: string;
  readonly userTurns: readonly string[];
  readonly botReplies: readonly (string | null)[];
}

export function toJudgeTranscript(
  messages: readonly ConversationMessage[],
  description = "Real call transcript",
): JudgeReadyTranscript {
  const userTurns: string[] = [];
  const botReplies: (string | null)[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      userTurns.push(m.content);
      botReplies.push(null);
      continue;
    }
    // assistant
    if (userTurns.length === 0) continue; // leading greeting → no customer turn to attach to
    const i = botReplies.length - 1;
    botReplies[i] = botReplies[i] == null ? m.content : `${botReplies[i]} ${m.content}`;
  }

  return { description, userTurns, botReplies };
}
