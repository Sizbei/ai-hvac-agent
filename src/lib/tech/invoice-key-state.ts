/**
 * Pure idempotency-key state machine for the technician money writes (spec §7.5).
 * One state per intent (a sheet or a primary action). The hook
 * `useIdempotencyKey` applies it; tests run in node.
 *
 * Unlisted (state, event) pairs return the SAME state object.
 */

export type KeyPhase = "idle" | "armed" | "sent" | "unknown";

export type KeyState =
  | { readonly phase: "idle" }
  | {
      readonly phase: Exclude<KeyPhase, "idle">;
      readonly key: string;
      readonly bodyHash: string;
      readonly body: unknown;
    };

export type KeyEvent =
  | { type: "open"; bodyHash: string; body: unknown; mint: () => string }
  | { type: "edit"; bodyHash: string; body: unknown; mint: () => string }
  | { type: "sent" }
  | { type: "spent" }
  | { type: "unknown" }
  | { type: "definitive_unstored" }
  | { type: "dropped" };

/** What the client does with a write's answer (`classifyWriteError` in
 * `./invoice-client-errors`, plus `success_refetch` for a 2xx). */
export type WriteOutcome =
  | "success_refetch"
  | "retry_same_key_after_refetch"
  | "wait_then_refetch"
  | "show_message_refetch"
  | "refetch_new_key"
  | "already_saved_refetch"
  | "spent_new_key";

export const IDLE: KeyState = { phase: "idle" };

export function nextKeyState(s: KeyState, e: KeyEvent): KeyState {
  switch (e.type) {
    case "open":
      // Only idle arms; an armed intent keeps its key, and sent/unknown are
      // read-only until the in-flight request is answered.
      return s.phase === "idle" ? { phase: "armed", key: e.mint(), bodyHash: e.bodyHash, body: e.body } : s;
    case "edit":
      // A changed body gets a new key only while nothing is in flight.
      return s.phase === "armed" && s.bodyHash !== e.bodyHash
        ? { phase: "armed", key: e.mint(), bodyHash: e.bodyHash, body: e.body }
        : s;
    case "sent":
      // armed → sent, or the re-send of the OLD body from unknown.
      return s.phase === "armed" || s.phase === "unknown" ? { ...s, phase: "sent" } : s;
    case "spent":
      return s.phase === "sent" ? IDLE : s;
    case "unknown":
      return s.phase === "sent" ? { ...s, phase: "unknown" } : s;
    case "definitive_unstored":
      // The server deleted the claim, so the same key is safe to reuse.
      return s.phase === "sent" || s.phase === "unknown" ? { ...s, phase: "armed" } : s;
    case "dropped":
      return IDLE;
  }
}

/** The event types a write outcome can produce (a subset of `KeyEvent["type"]`
 * that needs no payload, so `dispatch({ type })` type-checks). */
export type OutcomeEventType = "spent" | "unknown" | "definitive_unstored" | "dropped";

/** The reducer event for a write outcome; `stateAdvanced` = the refetch showed
 * the write (or another one) already landed. */
export function outcomeEvent(o: WriteOutcome, stateAdvanced: boolean): OutcomeEventType | null {
  switch (o) {
    case "success_refetch":
    case "already_saved_refetch":
    case "spent_new_key":
    case "refetch_new_key":
      return "spent";
    case "retry_same_key_after_refetch":
    case "wait_then_refetch":
      return stateAdvanced ? "dropped" : "unknown";
    case "show_message_refetch":
      return stateAdvanced ? "dropped" : "definitive_unstored";
    default:
      return null;
  }
}
