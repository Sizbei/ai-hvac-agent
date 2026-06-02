'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import type { SessionState } from '@/lib/ai/state-machine';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';
import type { ChatMessage, ExtractionField } from '@/lib/types/chat';

interface SessionData {
  readonly sessionId: string;
  readonly status: SessionState;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  readonly turnCount: number;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
    readonly createdAt: string;
  }[];
}

interface UseChatSessionReturn {
  readonly messages: readonly ChatMessage[];
  readonly status: SessionState;
  readonly isStreaming: boolean;
  readonly extraction: ExtractionResult | null;
  readonly extractionFields: readonly ExtractionField[];
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly sendMessage: (text: string) => void;
  readonly escalate: () => Promise<void>;
  readonly confirm: (data: ExtractionResult) => Promise<{ referenceNumber: string }>;
}

const TERMINAL_STATES: readonly SessionState[] = ['escalated', 'abandoned', 'submitted'];

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
  const sessionCreatedRef = useRef(false);
  const previousStatusRef = useRef<string>('ready');

  // Configure TextStreamChatTransport to match backend's { message: string } body format
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages: msgs, ...rest }) => {
          // Extract the last user message content from UIMessage parts
          const lastUserMsg = msgs.filter((m) => m.role === 'user').at(-1);
          const content =
            lastUserMsg?.parts
              ?.filter(
                (p): p is { type: 'text'; text: string } => p.type === 'text',
              )
              .map((p) => p.text)
              .join('') ?? '';
          return {
            ...rest,
            body: { message: content },
          };
        },
      }),
    [],
  );

  const {
    messages: uiMessages,
    setMessages,
    sendMessage: aiSendMessage,
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
        collected:
          extraction?.address != null && extraction.address.length > 0,
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
        const headers: Record<string, string> = {};
        if (typeof window !== 'undefined') {
          const key = new URLSearchParams(window.location.search).get('key');
          if (key) headers['X-HVAC-Widget-Key'] = key;
        }
        const res = await fetch('/api/session', { method: 'POST', headers });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: { message: 'Failed to create session' } }));
          setSessionError(body?.error?.message ?? 'Failed to create session');
        }
        // Session cookie is set by the server response (httpOnly).
      } catch {
        setSessionError('Could not connect to server. Please try again.');
      }
    }

    async function init(): Promise<void> {
      try {
        // Try to resume: the httpOnly session cookie survives a page refresh.
        const res = await fetch('/api/session');
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
        setSessionError('Could not connect to server. Please try again.');
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

    let attempts = 0;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    async function pollSession(): Promise<void> {
      try {
        const res = await fetch('/api/session');
        if (!res.ok) {
          failures += 1;
          if (failures >= 3) {
            setSessionError('Could not refresh session status. Your data may be stale.');
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

        // Retry polling for extraction results (background extraction may still be running)
        attempts += 1;
        if (attempts < 6) {
          timerId = setTimeout(pollSession, 3000);
        }
      } catch {
        failures += 1;
        if (failures >= 3) {
          setSessionError('Could not refresh session status. Your data may be stale.');
        }
      }
    }

    pollSession();

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [chatStatus]);

  // Wrap sendMessage to accept plain text
  const sendMessage = useCallback(
    (text: string): void => {
      if (isTerminalOrSubmitted(sessionStatus) || isStreaming || isLoading) {
        return;
      }
      setSessionError(null);
      aiSendMessage({ text });
    },
    [sessionStatus, isStreaming, isLoading, aiSendMessage],
  );

  // Escalate to human
  const escalate = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/session/escalate', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: 'Escalation failed' } }));
        setSessionError(body?.error?.message ?? 'Escalation failed');
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
    ): Promise<{ referenceNumber: string }> => {
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
        const body = await res.json().catch(() => ({ error: { message: 'Confirmation failed' } }));
        throw new Error(body?.error?.message ?? 'Confirmation failed');
      }

      const result = (await res.json()) as {
        success: boolean;
        data: { referenceNumber: string; serviceRequestId: string; status: string };
      };

      setSessionStatus('submitted');
      return { referenceNumber: result.data.referenceNumber };
    },
    [],
  );

  // Merge chat error with session error
  const error = sessionError ?? (chatError ? chatError.message : null);

  return {
    messages,
    status: sessionStatus,
    isStreaming,
    extraction,
    extractionFields,
    error,
    isLoading,
    sendMessage,
    escalate,
    confirm,
  };
}
