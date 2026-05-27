'use client';

import { useEffect } from 'react';
import { ChatErrorFallback } from '@/components/chat/chat-error-fallback';

export default function ChatError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-dvh max-w-lg mx-auto items-center justify-center">
      <ChatErrorFallback
        error={error}
        onRetry={unstable_retry}
        context="chat"
      />
    </div>
  );
}
