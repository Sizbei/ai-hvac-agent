import { logger } from "@/lib/logger";

export interface AICallMetrics {
  readonly operation: string;
  readonly latencyMs: number;
  readonly tokensUsed: number;
  readonly success: boolean;
  readonly error?: string;
}

export interface AICallResult<T> {
  readonly result: T;
  readonly metrics: AICallMetrics;
}

/**
 * Wraps an async AI call with performance and usage metrics.
 * Logs structured metrics via Pino on both success and failure.
 * Re-throws any error from the wrapped function after logging.
 */
export async function trackAICall<T>(
  operation: string,
  fn: () => Promise<T>,
  extractTokens: (result: T) => number,
): Promise<AICallResult<T>> {
  const start = performance.now();

  try {
    const result = await fn();
    const latencyMs = Math.round(performance.now() - start);
    const tokensUsed = extractTokens(result);

    const metrics: AICallMetrics = {
      operation,
      latencyMs,
      tokensUsed,
      success: true,
    };

    logger.info({ aiMetrics: metrics }, "AI call completed");

    return { result, metrics };
  } catch (error: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    const metrics: AICallMetrics = {
      operation,
      latencyMs,
      tokensUsed: 0,
      success: false,
      error: errorMessage,
    };

    logger.error({ aiMetrics: metrics }, "AI call failed");

    throw error;
  }
}
