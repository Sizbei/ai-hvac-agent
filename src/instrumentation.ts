import type { Instrumentation } from 'next';
import { registerOTel } from '@vercel/otel';
import { validateEnvVars } from '@/lib/env-validation';

/**
 * OpenTelemetry registration for observability.
 *
 * This function is called automatically by Next.js at build time
 * to register the OTel instrumentation for tracing and monitoring.
 *
 * @see https://vercel.com/docs/observability/otel-integration
 */
export async function register() {
  // Validate environment variables at startup to fail fast on missing config
  validateEnvVars();

  registerOTel({
    serviceName: 'ai-hvac-agent',
  });

  // DEGRADE-SAFE error tracking: without SENTRY_DSN the SDK is never even
  // loaded (it is ~1.3 MB and ran on every function boot for nothing).
  if (!process.env.SENTRY_DSN) return;
  const { initSentryServer, initSentryEdge } = await import('@/lib/observability/sentry');
  if (process.env.NEXT_RUNTIME === 'edge') {
    initSentryEdge();
  } else {
    initSentryServer();
  }
}

/**
 * Next 16 server-error hook. Forwards request errors to Sentry only when the
 * SDK has been initialized (i.e. SENTRY_DSN present); otherwise the underlying
 * SDK call is inert, so this is a no-op without a DSN.
 *
 * The fork routes proxy.ts errors through this hook too (context.routeType can
 * be 'proxy'); Sentry's captureRequestError accepts the Next context as-is.
 */
export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  if (!process.env.SENTRY_DSN) return;
  void import('@sentry/nextjs').then((Sentry) =>
    Sentry.captureRequestError(err, request, context),
  );
};
