'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ChatErrorFallbackProps {
  readonly error: Error & { digest?: string };
  readonly onRetry: () => void;
  readonly context?: 'chat' | 'success' | 'root';
}

function getContextMessage(context: ChatErrorFallbackProps['context']): string {
  switch (context) {
    case 'chat':
      return 'We couldn’t connect to the chat service. Please try again.';
    case 'success':
      return 'We couldn’t load the confirmation page.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}

export function ChatErrorFallback({
  error,
  onRetry,
  context,
}: ChatErrorFallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="size-12 text-orange-500" aria-hidden="true" />
      <h2 className="text-xl font-semibold text-foreground">
        Something went wrong
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {getContextMessage(context)}
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          Error ID: {error.digest}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button variant="default" onClick={onRetry}>
          Try Again
        </Button>
        <Button variant="outline" render={<Link href="/" />}>
          Go Home
        </Button>
      </div>
    </div>
  );
}
