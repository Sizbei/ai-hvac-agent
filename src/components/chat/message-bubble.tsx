'use client';

import { motion, useReducedMotion } from 'motion/react';
import { ANIMATION } from '@/lib/design-tokens';
import type { ChatMessage } from '@/lib/types/chat';

interface MessageBubbleProps {
  readonly message: ChatMessage;
  readonly isLatest?: boolean;
}

export function MessageBubble({ message, isLatest }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const reduceMotion = useReducedMotion();
  const hasAttachments = message.attachments && message.attachments.length > 0;

  return (
    <motion.div
      initial={isLatest && !reduceMotion ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.messageSlideUp.duration,
        ease: ANIMATION.messageSlideUp.ease,
      }}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[80%] shadow-sm ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-2xl rounded-br-md'
            : 'bg-card border border-border rounded-2xl rounded-bl-md'
        }`}
      >
        {/* Image Attachments */}
        {hasAttachments && (
          <div className="p-2 pt-3">
            <div className="flex flex-col gap-2">
              {message.attachments!.map((attachment) => (
                <div
                  key={attachment.id}
                  className="rounded-lg overflow-hidden border border-border/20"
                >
                  <img
                    src={attachment.url}
                    alt={attachment.filename}
                    className="w-full h-auto max-h-64 object-cover"
                    loading="lazy"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Message Text */}
        {message.content && (
          <div className={`px-4 py-2.5 ${hasAttachments ? 'pt-2' : ''}`}>
            <p className="text-sm whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
