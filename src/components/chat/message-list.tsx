'use client';

import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from '@/components/chat/message-bubble';
import { MessageFeedback } from '@/components/chat/message-feedback';
import { TypingIndicator } from '@/components/chat/typing-indicator';
import type { ChatMessage } from '@/lib/types/chat';

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly isStreaming: boolean;
  /** Enable the 👍/👎 control under assistant answers. */
  readonly showFeedback?: boolean;
}

export function MessageList({ messages, isStreaming, showFeedback }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastAssistantRef = useRef<HTMLDivElement>(null);

  const lastIndex = messages.length - 1;
  const lastRole = messages[lastIndex]?.role;

  useEffect(() => {
    // For a new assistant message, scroll its TOP into view so the customer
    // reads from the start of (possibly long) safety/FAQ answers (NN/G #7).
    // For the customer's own messages, follow to the bottom as usual.
    if (lastRole === 'assistant' && lastAssistantRef.current) {
      lastAssistantRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isStreaming, lastRole]);

  const showTypingIndicator =
    isStreaming && (messages.length === 0 || messages[lastIndex]?.role !== 'assistant');

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div
        className="flex flex-col gap-3 p-4"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Conversation"
      >
        {messages.map((message, index) => {
          const isAssistant = message.role === 'assistant';
          const isLast = index === lastIndex;
          return (
            <div
              key={message.id}
              ref={isAssistant && isLast ? lastAssistantRef : undefined}
            >
              <MessageBubble message={message} isLatest={isLast} />
              {showFeedback && isAssistant && message.id !== 'welcome' && (
                <div className="flex justify-start">
                  <MessageFeedback messageIndex={index} />
                </div>
              )}
            </div>
          );
        })}
        {showTypingIndicator && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
