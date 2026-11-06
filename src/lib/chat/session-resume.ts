/**
 * Pure: which sessions the chat client rehydrates on load, and the extraction
 * snapshot it restores from the session's metadata JSON.
 *
 * Escalated sessions resume (read-only — the input stays locked by
 * `chatEndActions`) so a customer who reloads or reopens the widget after a
 * gas/CO emergency still sees the emergency panel and the call button, not a
 * fresh greeting (round-2 UX N-P1-3). 'confirmed' / 'submitted' / 'abandoned'
 * still start fresh: they have no resumable UI.
 */
import type { SessionState } from "@/lib/ai/state-machine";
import type { ExtractionResult } from "@/lib/ai/extraction-schema";

export const RESUMABLE_STATES: readonly SessionState[] = [
  "chatting",
  "extracting",
  "escalated",
];

export function shouldResumeSession(
  status: SessionState,
  messageCount: number,
): boolean {
  return RESUMABLE_STATES.includes(status) && messageCount > 0;
}

/** The session metadata as an extraction snapshot, or null if not one yet. */
export function parseResumedExtraction(
  metadata: unknown,
): ExtractionResult | null {
  if (typeof metadata !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && "issueType" in parsed) {
      return parsed as ExtractionResult;
    }
  } catch {
    // Not valid extraction JSON yet.
  }
  return null;
}
