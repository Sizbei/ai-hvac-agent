/**
 * Streaming state components for enhanced UX.
 * Provides consistent loading, error, and retry UI following Vercel patterns.
 *
 * Stage 5: Streaming & Data Management
 */

'use client';

import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Streaming loading indicator with optional message */
export function StreamingLoader({ message = 'Thinking...' }: { readonly message?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      <span>{message}</span>
    </div>
  );
}

/** Streaming error alert with retry option */
export function StreamingError({
  error,
  onRetry,
  onDismiss,
}: {
  readonly error: Error;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
}) {
  return (
    <Alert variant="destructive" className="relative">
      <AlertCircle className="size-4" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          <RefreshCw className="size-4 mr-2" />
          Retry
        </Button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-2 top-2 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          <span className="sr-only">Dismiss</span>
          ×
        </button>
      )}
    </Alert>
  );
}

/** Skeleton placeholder for messages while streaming */
export function MessageSkeleton({ count = 1 }: { readonly count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <div className="size-8 shrink-0 rounded-sm bg-surface-sunken" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Retry prompt shown when a request fails */
export function RetryPrompt({
  message = 'Request failed. Try again?',
  onRetry,
  isRetrying,
}: {
  readonly message?: string;
  readonly onRetry: () => void;
  readonly isRetrying?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <AlertCircle className="size-4" />
      <span>{message}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRetry}
        disabled={isRetrying}
      >
        <RefreshCw className={cn('size-4 mr-2', isRetrying && 'animate-spin')} />
        Retry
      </Button>
    </div>
  );
}

/** Connection status indicator (shows when offline) */
export function ConnectionStatus({ isOnline }: { readonly isOnline: boolean }) {
  if (isOnline) return null;

  return (
    <div className="flex items-center gap-2 border-t border-warning-border bg-warning-light px-4 py-2 text-xs text-warning-strong">
      <AlertCircle className="size-3" />
      <span>You&apos;re offline. Messages will send when you reconnect.</span>
    </div>
  );
}

/** Typing indicator for streaming responses */
export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <span className="size-1 animate-pulse bg-current [animation-delay:-0.4s]" />
      <span className="size-1 animate-pulse bg-current [animation-delay:-0.2s]" />
      <span className="size-1 animate-pulse bg-current" />
    </div>
  );
}

/** Streaming progress bar for file uploads or long operations */
export function StreamingProgress({
  progress,
  message,
}: {
  readonly progress: number;
  readonly message?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{message || 'Uploading...'}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-[2px] bg-surface-sunken">
        <div
          className="h-full bg-marker transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
