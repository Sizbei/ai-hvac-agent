'use client';

import { motion } from 'motion/react';
import { ANIMATION } from '@/lib/design-tokens';
import type { ChatMessage } from '@/lib/types/chat';

interface MessageBubbleProps {
  readonly message: ChatMessage;
  readonly isLatest?: boolean;
}

export function MessageBubble({ message, isLatest }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <motion.div
      initial={isLatest ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.messageSlideUp.duration,
        ease: ANIMATION.messageSlideUp.ease,
      }}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[80%] px-4 py-2.5 shadow-sm ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-2xl rounded-br-md'
            : 'bg-card border border-border rounded-2xl rounded-bl-md'
        }`}
      >
        <p className="text-sm whitespace-pre-wrap break-words">
          {message.content}
        </p>
      </div>
    </motion.div>
  );
}
