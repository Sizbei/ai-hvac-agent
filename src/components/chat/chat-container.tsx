'use client';

import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { ChatInput } from '@/components/chat/chat-input';
import type { ChatContainerProps } from '@/lib/types/chat';

export function ChatContainer({
  messages,
  status,
  isStreaming,
  onSendMessage,
  onEscalate,
  inputDisabled = false,
}: ChatContainerProps) {
  return (
    <div className="flex flex-col h-dvh md:mx-auto md:max-w-lg md:shadow-lg">
      <ChatHeader status={status} onEscalate={onEscalate} />
      <MessageList messages={messages} isStreaming={isStreaming} />
      <ChatInput
        onSendMessage={onSendMessage}
        disabled={inputDisabled || isStreaming}
        placeholder={
          isStreaming ? 'Waiting for response...' : 'Describe your HVAC issue...'
        }
      />
    </div>
  );
}
