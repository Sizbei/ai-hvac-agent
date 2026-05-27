'use client';

import { useState, useCallback } from 'react';
import { ChatContainer } from '@/components/chat/chat-container';
import type { ChatMessage } from '@/lib/types/chat';

const INITIAL_MESSAGES: readonly ChatMessage[] = [
  {
    id: '1',
    role: 'assistant',
    content:
      "Hi! I'm your HVAC assistant. What issue are you experiencing today?",
  },
  {
    id: '2',
    role: 'user',
    content: 'My air conditioning stopped working this morning.',
  },
  {
    id: '3',
    role: 'assistant',
    content:
      "I'm sorry to hear that. Can you tell me your address so we can check service availability in your area?",
  },
];

export default function ChatPage() {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(INITIAL_MESSAGES);

  const handleSendMessage = useCallback((content: string) => {
    const newMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date(),
    };
    setMessages((prev) => [...prev, newMessage]);
  }, []);

  const handleEscalate = useCallback(() => {
    // No-op: wired in Plan 03
  }, []);

  const handleConfirm = useCallback(() => {
    // No-op: wired in Plan 03
  }, []);

  return (
    <ChatContainer
      messages={messages}
      status="chatting"
      isStreaming={false}
      extraction={null}
      onSendMessage={handleSendMessage}
      onEscalate={handleEscalate}
      onConfirm={handleConfirm}
    />
  );
}
