/**
 * Pure: human copy for the customer chat's failure paths.
 *
 * - `chatErrorCopy` turns a failed /api/chat (or /api/session) response into a
 *   sentence a homeowner can act on. The AI SDK hands us the raw response text
 *   (`{"success":false,"error":{...}}`), which must never reach the UI.
 * - `emptyReplyFallback` covers the HTTP-200-but-empty reply (the model call
 *   failed upstream and the stream ended with no text): never leave silence.
 */

export type ChatErrorRecovery = "retry" | "restart";

export interface ChatErrorCopy {
  readonly message: string;
  readonly recovery: ChatErrorRecovery;
}

const GENERIC: ChatErrorCopy = {
  message: "Sorry, something went wrong sending your message. Please try again.",
  recovery: "retry",
};

const BY_CODE: Readonly<Record<string, ChatErrorCopy>> = {
  NO_SESSION: {
    message: "This chat timed out. Start a new conversation to keep going.",
    recovery: "restart",
  },
  SESSION_NOT_FOUND: {
    message: "This chat timed out. Start a new conversation to keep going.",
    recovery: "restart",
  },
  SESSION_TERMINATED: {
    message: "This chat has ended. Start a new conversation to keep going.",
    recovery: "restart",
  },
  SESSION_SUBMITTED: {
    message: "Your request is already in. Start a new conversation to ask something else.",
    recovery: "restart",
  },
  RATE_LIMITED: {
    message: "That's a lot of messages in a short time. Please wait a minute and try again.",
    recovery: "retry",
  },
  GUARDRAIL_BLOCKED: {
    message: "Sorry, I couldn't process that message. Please rephrase it and try again.",
    recovery: "retry",
  },
  INVALID_MESSAGE: {
    message: "Please type a message before sending.",
    recovery: "retry",
  },
};

/** Pull `error.code` out of an API error envelope (raw JSON text), if any. */
function errorCode(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error?: unknown }).error;
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code?: unknown }).code;
        return typeof code === "string" ? code : null;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function chatErrorCopy(raw: string | null | undefined): ChatErrorCopy | null {
  if (raw == null) return null;
  const code = errorCode(raw);
  return (code && BY_CODE[code]) || GENERIC;
}

/** Copy for a session that could not be created or resumed (no transcript). */
export function sessionStartErrorCopy(status: number | null): string {
  if (status === 429) {
    return "Too many chats were started from this network just now. Please wait a minute and try again.";
  }
  if (status === 403) {
    return "This chat isn't available on this website right now.";
  }
  return "We couldn't start the chat. Please try again.";
}

export interface ChatTurnLike {
  readonly role: string;
  readonly content: string;
}

/**
 * True when the last turn finished with no assistant text: the customer's
 * message is last, or the assistant bubble after it is blank. Only meaningful
 * once streaming has stopped and the customer has sent something.
 */
export function isEmptyReply(messages: readonly ChatTurnLike[]): boolean {
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.role !== "assistant") return false;
  if (last.content.trim().length > 0) return false;
  // A blank assistant bubble only counts after a real customer message.
  return messages.slice(0, -1).some((m) => m.role === "user");
}

export interface EmptyReplyContext {
  /** The customer's message that got no reply. */
  readonly lastUserMessage?: string | null;
  /** The pending intake question, when the issue is already known. */
  readonly nextQuestion?: string | null;
}

const QUESTION_LEAD =
  /^(?:how|what|whats|what's|why|when|where|who|which|can|could|do|does|did|is|are|should|will|would|may)\b/i;

/** True when the message reads as a question rather than a problem report. */
export function isQuestionMessage(message: string): boolean {
  const t = message.trim();
  return t.endsWith("?") || QUESTION_LEAD.test(t);
}

/**
 * Copy for a turn that ended with no reply (the model call failed). It never
 * dead-ends: the deterministic intake still works without the model, so the
 * copy points at it (round-2 UX N-P1-4).
 * - issue known, a step pending → "I can still book a visit for you." + that
 *   step's question (the server captures the answer without the model);
 * - a problem report → "I can still get a technician out." + the issue chips;
 * - a question → "Sorry, I couldn't answer that." + the booking offer.
 */
export function emptyReplyFallback(
  phone: string | null | undefined,
  ctx: EmptyReplyContext = {},
): string {
  const display = phone?.trim();
  const orCall = display ? `, or call us at ${display}` : "";
  const nextQuestion = ctx.nextQuestion?.trim();
  if (nextQuestion) {
    return `Sorry, I couldn't answer that. I can still book a visit for you. ${nextQuestion}`;
  }
  const last = ctx.lastUserMessage?.trim() ?? "";
  if (last && !isQuestionMessage(last)) {
    return `I can still get a technician out. Tap the closest option below${orCall}.`;
  }
  return `Sorry, I couldn't answer that. I can still book a visit for you. Tap the closest option below${orCall}.`;
}
