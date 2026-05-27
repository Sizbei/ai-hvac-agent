'use client';

import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from '@/components/chat/message-bubble';
import { TypingIndicator } from '@/components/chat/typing-indicator';
import type { ChatMessage } from '@/lib/types/chat';

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly isStreaming: boolean;
}

export function MessageList({ messages, isStreaming }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isStreaming]);

  const showTypingIndicator =
    isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant');

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div className="flex flex-col gap-3 p-4">
        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            isLatest={index === messages.length - 1}
          />
        ))}
        {showTypingIndicator && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
