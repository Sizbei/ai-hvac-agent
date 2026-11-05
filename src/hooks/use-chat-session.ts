'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import type { SessionState } from '@/lib/ai/state-machine';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';
import {
  isAddressComplete,
  isNameComplete,
  isEmailComplete,
} from '@/lib/ai/extraction-schema';
import type { ChatMessage, ExtractionField, UploadedAttachment } from '@/lib/types/chat';
import {
  chatErrorCopy,
  sessionStartErrorCopy,
  type ChatErrorRecovery,
} from '@/lib/chat/chat-turn-feedback';

interface SessionData {
  readonly sessionId: string;
  readonly status: SessionState;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  readonly turnCount: number;
  readonly companyName?: string | null;
  readonly companyPhone?: string | null;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
    readonly createdAt: string;
  }[];
}

interface UseChatSessionReturn {
  readonly companyName: string | null;
  /** The org's business phone (tap-to-call), or null when none is configured. */
  readonly companyPhone: string | null;
  readonly messages: readonly ChatMessage[];
  readonly status: SessionState;
  readonly isStreaming: boolean;
  readonly extraction: ExtractionResult | null;
  readonly extractionFields: readonly ExtractionField[];
  /** Human copy only — never a raw server message or JSON envelope. */
  readonly error: string | null;
  /** How the customer can recover from `error`: resend, or start over. */
  readonly errorRecovery: ChatErrorRecovery | null;
  /** True when no session could be created/resumed (nothing to send into). */
  readonly sessionUnavailable: boolean;
  readonly isLoading: boolean;
  /** Resend the last customer message (after an empty or failed reply). */
  readonly retryLastMessage: () => void;
  readonly sendMessage: (text: string, attachments?: readonly UploadedAttachment[]) => void;
  readonly escalate: () => Promise<void>;
  readonly confirm: (
    data: ExtractionResult,
  ) => Promise<{ referenceNumber: string; arrivalWindowLabel: string | null }>;
  /** Abandon the current session and start a fresh one (clears the transcript,
   * extraction, and status; mints a new server session + cookie). */
  readonly startNewConversation: () => Promise<void>;
}

const TERMINAL_STATES: readonly SessionState[] = ['escalated', 'abandoned', 'submitted'];

// Shown only if the server failed to persist/return a greeting — normally the
// org-branded copy comes back from POST /api/session (where it's also stored
// as the session's first assistant message).
const FALLBACK_GREETING =
  "Hi, I'm here to help get your heating or cooling sorted and a technician on the way. Tell me what's going on, and I'll take care of the rest.";

/** The greeting as a UIMessage, seeding a fresh transcript so the welcome is a
 * real first message that persists once the customer replies. */
function greetingUiMessage(text: string): UIMessage {
  return {
    id: 'greeting',
    role: 'assistant',
    parts: [{ type: 'text', text }],
  };
}

function isTerminalOrSubmitted(status: SessionState): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Custom hook orchestrating session creation, chat streaming via AI SDK useChat,
 * extraction progress tracking, and session state management.
 */
export function useChatSession(): UseChatSessionReturn {
  const [sessionStatus, setSessionStatus] = useState<SessionState>('chatting');
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [companyPhone, setCompanyPhone] = useState<string | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const sessionCreatedRef = useRef(false);
  const previousStatusRef = useRef<string>('ready');

  // Configure TextStreamChatTransport to match backend's { message: string } body format
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages: msgs, body: callBody, ...rest }) => {
          // Extract the last user message content from UIMessage parts
          const lastUserMsg = msgs.filter((m) => m.role === 'user').at(-1);
          const content =
            lastUserMsg?.parts
              ?.filter(
                (p): p is { type: 'text'; text: string } => p.type === 'text',
              )
              .map((p) => p.text)
              .join('') ?? '';
          // Forward any per-call body fields (e.g. addressSelected, set when the
          // customer picks a result from the address lookup) alongside the
          // message so the backend can trust a structured selection verbatim.
          return {
            ...rest,
            body: { message: content, ...(callBody ?? {}) },
          };
        },
      }),
    [],
  );

  const {
    messages: uiMessages,
    setMessages,
    sendMessage: aiSendMessage,
    regenerate,
    clearError,
    status: chatStatus,
    error: chatError,
  } = useChat({ transport });

  // Convert UIMessage[] (with .parts) to ChatMessage[] (with .content string)
  const messages: readonly ChatMessage[] = useMemo(
    () =>
      uiMessages.map((m: UIMessage) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.parts
          .filter(
            (p): p is { type: 'text'; text: string } => p.type === 'text',
          )
          .map((p) => p.text)
          .join(''),
      })),
    [uiMessages],
  );

  // Derive extraction field status from ExtractionResult
  const extractionFields: readonly ExtractionField[] = useMemo(
    () => [
      {
        key: 'issueType' as const,
        label: 'Issue Type',
        collected: extraction?.issueType != null,
      },
      {
        key: 'urgency' as const,
        label: 'Urgency',
        collected: extraction?.urgency != null,
      },
      {
        key: 'address' as const,
        label: 'Address',
        collected: isAddressComplete(extraction?.address ?? null),
      },
      {
        key: 'customerName' as const,
        label: 'Name',
        collected: isNameComplete(extraction?.customerName ?? null),
      },
      {
        key: 'customerPhone' as const,
        label: 'Phone',
        collected:
          extraction?.customerPhone != null &&
          extraction.customerPhone.length > 0,
      },
      {
        key: 'customerEmail' as const,
        label: 'Email',
        collected: isEmailComplete(extraction?.customerEmail ?? null),
      },
    ],
    [extraction],
  );

  const isStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';

  // Resume an existing session (cookie persists across refresh) or create one.
  useEffect(() => {
    if (sessionCreatedRef.current) return;
    sessionCreatedRef.current = true;

    // 'confirmed' is intentionally excluded: the confirm endpoint transitions
    // straight to 'submitted', so a 'confirmed' row only exists after a crash and
    // has no resumable UI (the ExtractionCard only renders for 'extracting').
    const RESUMABLE: readonly SessionState[] = ['chatting', 'extracting'];

    async function createSession(): Promise<void> {
      try {
        // When rendered inside the embed iframe the URL carries the org's
        // publishable widget key (?key=pk_live_…). Forward it so the session is
        // attributed to that org. The hosted /chat page has no key → demo org.
        const res = await fetch('/api/session', {
          method: 'POST',
          headers: widgetKeyHeaders(),
        });
        if (!res.ok) {
          setSessionError(sessionStartErrorCopy(res.status));
          setSessionUnavailable(true);
          return;
        }
        // Session cookie is set by the server response (httpOnly). Seed the
        // transcript with the greeting the server just persisted as the
        // session's first assistant message, so the welcome the customer sees
        // IS the conversation's first turn (not a display-only bubble that
        // vanishes when they reply).
        const body = (await res.json().catch(() => null)) as {
          data?: {
            greeting?: string | null;
            companyName?: string | null;
            companyPhone?: string | null;
          };
        } | null;
        if (body?.data?.companyName) setCompanyName(body.data.companyName);
        setCompanyPhone(body?.data?.companyPhone ?? null);
        setMessages([
          greetingUiMessage(body?.data?.greeting ?? FALLBACK_GREETING),
        ]);
      } catch {
        setSessionError(sessionStartErrorCopy(null));
        setSessionUnavailable(true);
      }
    }

    // The org's publishable widget key from ?key=… (embed iframe). Forwarded on
    // BOTH create and resume so a session is created for / resumed within the
    // correct org — without it, resume would rehydrate a stale cookie from
    // another org's widget.
    function widgetKeyHeaders(): Record<string, string> {
      const headers: Record<string, string> = {};
      if (typeof window !== 'undefined') {
        const key = new URLSearchParams(window.location.search).get('key');
        if (key) headers['X-HVAC-Widget-Key'] = key;
      }
      return headers;
    }

    async function init(): Promise<void> {
      try {
        // Try to resume: the httpOnly session cookie survives a page refresh.
        // Forward the widget key so a cross-org cookie is NOT resumed (server
        // returns NO_SESSION on mismatch → we fall through to createSession).
        const res = await fetch('/api/session', { headers: widgetKeyHeaders() });
        if (res.ok) {
          const body = (await res.json()) as {
            success: boolean;
            data: SessionData & { metadata?: string };
          };
          const s = body?.data;
          if (
            body.success &&
            s &&
            RESUMABLE.includes(s.status) &&
            s.messages.length > 0
          ) {
            // Rehydrate the chat transcript so a refresh doesn't lose progress.
            setMessages(
              s.messages.map((m, i) => ({
                id: `resumed-${i}`,
                role: m.role as 'user' | 'assistant',
                parts: [{ type: 'text', text: m.content }],
              })),
            );
            setSessionStatus(s.status);
            // Keep the org's own brand on a reload/resume (the header would
            // otherwise fall back to a generic name).
            if (s.companyName) setCompanyName(s.companyName);
            setCompanyPhone(s.companyPhone ?? null);
            if (typeof s.metadata === 'string') {
              try {
                const parsed = JSON.parse(s.metadata) as ExtractionResult;
                if (parsed && typeof parsed === 'object' && 'issueType' in parsed) {
                  setExtraction(parsed);
                }
              } catch {
                // Not valid extraction JSON yet — ignore.
              }
            }
            return;
          }
        }
        // No resumable session — create a fresh one.
        await createSession();
      } catch {
        setSessionError(sessionStartErrorCopy(null));
        setSessionUnavailable(true);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, [setMessages]);

  // Poll session state after streaming finishes, with retries for background extraction
  useEffect(() => {
    const wasActive =
      previousStatusRef.current === 'streaming' ||
      previousStatusRef.current === 'submitted';
    const isNowReady = chatStatus === 'ready';

    previousStatusRef.current = chatStatus;

    if (!wasActive || !isNowReady) return;

    // Async extraction runs in a background after() task, so the result usually
    // lands within a second or two of the stream finishing. Poll fast first,
    // then back off exponentially — this cuts perceived latency in the common
    // case while staying bounded if extraction never completes. Each entry is
    // the delay (ms) BEFORE that attempt; total budget ~14s across 6 attempts.
    const POLL_BACKOFF_MS: readonly number[] = [800, 1500, 2500, 4000, 5000];

    let attempts = 0;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    async function pollSession(): Promise<void> {
      try {
        const res = await fetch('/api/session');
        if (!res.ok) {
          failures += 1;
          if (failures >= 3) {
            setSessionError("We're having trouble staying connected. Your messages are saved; please try again in a moment.");
          }
          return;
        }

        failures = 0;

        const body = (await res.json()) as {
          success: boolean;
          data: SessionData & { metadata?: string };
        };
        if (!body.success) return;

        const session = body.data;
        setSessionStatus(session.status);

        if ('metadata' in session && typeof session.metadata === 'string') {
          try {
            const parsed = JSON.parse(session.metadata) as ExtractionResult;
            if (parsed && typeof parsed === 'object' && 'issueType' in parsed) {
              setExtraction(parsed);
              return;
            }
          } catch {
            // Metadata not valid extraction JSON yet
          }
        }

        // Retry polling for extraction results (background extraction may still
        // be running). Schedule the next check with exponential backoff and stop
        // once the backoff schedule is exhausted (bounded retries).
        const nextDelay = POLL_BACKOFF_MS[attempts];
        attempts += 1;
        if (nextDelay !== undefined) {
          timerId = setTimeout(pollSession, nextDelay);
        }
      } catch {
        failures += 1;
        if (failures >= 3) {
          setSessionError("We're having trouble staying connected. Your messages are saved; please try again in a moment.");
        }
      }
    }

    // Kick off the first check quickly — extraction often finishes almost
    // immediately after the stream ends — then fall into the backoff schedule.
    timerId = setTimeout(pollSession, 300);

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [chatStatus]);

  // Wrap sendMessage to accept plain text and optional attachments
  const sendMessage = useCallback(
    (text: string, attachments?: readonly UploadedAttachment[]): void => {
      if (
        isTerminalOrSubmitted(sessionStatus) ||
        isStreaming ||
        isLoading ||
        sessionUnavailable
      ) {
        return;
      }
      setSessionError(null);
      if (chatError) clearError();

      const attachmentIds = attachments?.map((a) => a.id) ?? [];

      // Attachment IDs must ride in the request OPTIONS (2nd arg) — the transport's
      // prepareSendMessagesRequest spreads `body` into the payload. Putting them on
      // the message object (as before) silently dropped them: the SDK only
      // serializes known message fields, so uploads were orphaned and an
      // attachment-only send hit the server as empty text (400).
      aiSendMessage(
        { text },
        attachmentIds.length > 0
          ? { body: { attachments: attachmentIds } }
          : undefined,
      );
    },
    [sessionStatus, isStreaming, isLoading, sessionUnavailable, chatError, clearError, aiSendMessage],
  );

  // Resend the customer's last message after an empty or failed reply.
  // regenerate() drops a trailing (blank) assistant bubble and resubmits the
  // last user message through the same transport.
  const retryLastMessage = useCallback((): void => {
    if (isTerminalOrSubmitted(sessionStatus) || isStreaming || isLoading) return;
    setSessionError(null);
    if (chatError) clearError();
    void regenerate();
  }, [sessionStatus, isStreaming, isLoading, chatError, clearError, regenerate]);

  // Escalate to human
  const escalate = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/session/escalate', { method: 'POST' });
      if (!res.ok) {
        setSessionError("We couldn't reach our team just now. Please try again.");
        return;
      }
      setSessionStatus('escalated');
    } catch {
      setSessionError('Could not connect to server. Please try again.');
    }
  }, []);

  // Confirm extraction and submit service request
  const confirm = useCallback(
    async (
      data: ExtractionResult,
    ): Promise<{
      referenceNumber: string;
      arrivalWindowLabel: string | null;
    }> => {
      const res = await fetch('/api/session/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueType: data.issueType,
          urgency: data.urgency,
          address: data.address,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          customerEmail: data.customerEmail,
          description: data.description,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string; code?: string };
        } | null;
        // Only DO_NOT_SERVICE carries customer-ready copy; anything else (validation
        // detail, internal failures) gets one human sentence instead.
        const code = body?.error?.code;
        const humanReady = code === 'DO_NOT_SERVICE' && body?.error?.message;
        throw new Error(
          humanReady ||
            "We couldn't submit your request just now. Please try again, or call our office and we'll take it directly.",
        );
      }

      const result = (await res.json()) as {
        success: boolean;
        data: {
          referenceNumber: string;
          serviceRequestId: string;
          status: string;
          // Present only when a concrete window was reserved; label is null-safe.
          arrivalWindow: { label: string | null } | null;
        };
      };

      setSessionStatus('submitted');
      return {
        referenceNumber: result.data.referenceNumber,
        arrivalWindowLabel: result.data.arrivalWindow?.label ?? null,
      };
    },
    [],
  );

  // Start a brand-new conversation: clear all client state, then mint a fresh
  // server session (POST /api/session always issues a new token + cookie, so the
  // old transcript is left behind and the next message starts clean). Used by
  // the "New conversation" control — and as the recovery path after submit /
  // escalation, where the input is otherwise locked.
  const startNewConversation = useCallback(async (): Promise<void> => {
    setSessionError(null);
    setSessionUnavailable(false);
    if (chatError) clearError();
    setExtraction(null);
    setMessages([]);
    setSessionStatus('chatting');
    try {
      const headers: Record<string, string> = {};
      if (typeof window !== 'undefined') {
        const key = new URLSearchParams(window.location.search).get('key');
        if (key) headers['X-HVAC-Widget-Key'] = key;
      }
      const res = await fetch('/api/session', { method: 'POST', headers });
      if (!res.ok) {
        setSessionError(sessionStartErrorCopy(res.status));
        setSessionUnavailable(true);
        return;
      }
      // Seed the new transcript with the greeting the server persisted as the
      // fresh session's first assistant message (same as initial creation).
      const body = (await res.json().catch(() => null)) as {
        data?: {
          greeting?: string | null;
          companyName?: string | null;
          companyPhone?: string | null;
        };
      } | null;
      if (body?.data?.companyName) setCompanyName(body.data.companyName);
      setCompanyPhone(body?.data?.companyPhone ?? null);
      setMessages([
        greetingUiMessage(body?.data?.greeting ?? FALLBACK_GREETING),
      ]);
    } catch {
      setSessionError(sessionStartErrorCopy(null));
      setSessionUnavailable(true);
    }
  }, [setMessages, chatError, clearError]);

  // Merge chat error with session error. The AI SDK's error message is the raw
  // response body (a JSON envelope) — map it to human copy, never show it.
  const chatErrorView = chatErrorCopy(chatError ? chatError.message : null);
  const error = sessionError ?? chatErrorView?.message ?? null;
  const errorRecovery: ChatErrorRecovery | null = sessionError
    ? sessionUnavailable
      ? 'restart'
      : null
    : (chatErrorView?.recovery ?? null);

  return {
    messages,
    companyName,
    companyPhone,
    status: sessionStatus,
    isStreaming,
    extraction,
    extractionFields,
    error,
    errorRecovery,
    sessionUnavailable,
    isLoading,
    retryLastMessage,
    sendMessage,
    escalate,
    confirm,
    startNewConversation,
  };
}
