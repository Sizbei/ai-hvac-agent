/**
 * Streaming utilities for enhanced chat UX.
 * Provides optimistic updates, retry logic, and proper request cancellation.
 *
 * Stage 5: Streaming & Data Management
 */

/** Request controller for abortable streaming requests */
export class StreamController {
  private abortController: AbortController | null = null;
  private requestId: number = 0;

  /** Start a new request and return its unique ID. Aborts any previous request. */
  startNew(): number {
    this.abort();
    this.abortController = new AbortController();
    return ++this.requestId;
  }

  /** Abort the current request if one is active */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Get the signal for the current request (for fetch/ai-sdk) */
  get signal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /** Check if the current request is for a given ID (prevents stale responses) */
  isCurrent(id: number): boolean {
    return id === this.requestId;
  }
}

/** Retry configuration for failed requests */
export interface RetryConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Default retry strategy: exponential backoff with jitter */
export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Retry a function with exponential backoff and jitter.
 * Stops retrying on non-retryable errors (4xx status, abort).
 */
export async function retryWithBackoff<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort (user cancelled) or 4xx client errors
      if (lastError.name === 'AbortError' || isClientError(lastError)) {
        throw lastError;
      }

      // Don't delay after the last attempt
      if (attempt < config.maxRetries) {
        const delay = calculateDelay(attempt, config);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/** Check if an error is a non-retryable client error (4xx status) */
function isClientError(error: Error): boolean {
  // Check for fetch errors with status
  if ('status' in error) {
    const status = (error as { status: number }).status;
    return status >= 400 && status < 500;
  }
  return false;
}

/** Calculate exponential backoff delay with jitter */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // ±15% jitter
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/** Optimistic message update - shows user message immediately */
export interface OptimisticMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly pending: boolean;
}

/**
 * Create an optimistic user message that appears immediately.
 * Replaced by the server-confirmed message once the request completes.
 */
export function createOptimisticMessage(content: string): OptimisticMessage {
  return {
    id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content,
    pending: true,
  };
}

/** Merge optimistic messages with confirmed messages, replacing pending ones */
export function mergeMessages<T extends { id: string }>(
  confirmed: readonly T[],
  optimistic: readonly T[],
): readonly T[] {
  const result = new Map<string, T>();

  // Add all confirmed messages
  confirmed.forEach((m) => result.set(m.id, m));

  // Add optimistic messages only if not replaced by confirmed
  optimistic.forEach((m) => {
    if (!result.has(m.id)) {
      result.set(m.id, m);
    }
  });

  return Array.from(result.values());
}

/** Streaming state tracked across the chat lifecycle */
export interface StreamState {
  readonly isStreaming: boolean;
  readonly isRetrying: boolean;
  readonly attempt: number;
  readonly error: Error | null;
}

/** Hook return value for streaming state management */
export interface StreamingControl {
  readonly state: StreamState;
  readonly startRequest: (message: string) => void;
  readonly cancelRequest: () => void;
  readonly retryRequest: () => void;
}

/**
 * SWR-style stale-while-revalidate configuration for data freshness.
 * Used for revalidating session state, customer data, etc.
 */
export interface RevalidationConfig {
  readonly staleTimeMs: number;
  readonly revalidateOnFocus: boolean;
  readonly revalidateOnReconnect: boolean;
}

/** Default revalidation: 30s stale time, revalidate on focus/reconnect */
export const DEFAULT_REVALIDATION: RevalidationConfig = {
  staleTimeMs: 30000,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
};

/**
 * SWR-inspired hook for data with automatic revalidation.
 * Returns cached data immediately (stale-while-revalidate),
 * then fetches fresh data in the background.
 */
export function createRevalidator<T>(
  fetcher: () => Promise<T>,
  config: RevalidationConfig = DEFAULT_REVALIDATION,
) {
  let data: T | null = null;
  let lastFetch: number = 0;
  let pending: Promise<T> | null = null;

  return {
    /**
     * Get data immediately (may be stale), then revalidate if needed.
     * Returns null if no data has been fetched yet.
     */
    getData(): T | null {
      const now = Date.now();
      const isStale = !data || now - lastFetch > config.staleTimeMs;

      if (isStale && !pending) {
        pending = fetcher()
          .then((fresh) => {
            data = fresh;
            lastFetch = Date.now();
            pending = null;
            return fresh;
          })
          .catch((err) => {
            pending = null;
            throw err;
          });
      }

      return data;
    },

    /** Force a revalidation, regardless of staleness */
    async revalidate(): Promise<T> {
      lastFetch = 0; // Force stale
      return this.getData()!;
    },

    /** Clear cached data (next call will fetch fresh) */
    reset(): void {
      data = null;
      lastFetch = 0;
    },
  };
}

/** Network status detection for revalidation on reconnect */
export function createNetworkMonitor() {
  const listeners = new Set<(online: boolean) => void>();

  if (typeof window !== 'undefined') {
    const handleOnline = () => {
      listeners.forEach((fn) => fn(true));
    };
    const handleOffline = () => {
      listeners.forEach((fn) => fn(false));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Return cleanup function
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }

  return () => {};
}

/** Focus detection for revalidation on window focus */
export function createFocusMonitor() {
  const listeners = new Set<() => void>();

  if (typeof window !== 'undefined') {
    const handleFocus = () => {
      listeners.forEach((fn) => fn());
    };

    window.addEventListener('focus', handleFocus);

    // Return cleanup function
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }

  return () => {};
}
