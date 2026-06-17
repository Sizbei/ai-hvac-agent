import type { Instrumentation } from 'next';
import { registerOTel } from '@vercel/otel';
import * as Sentry from '@sentry/nextjs';
import { validateEnvVars } from '@/lib/env-validation';
import { initSentryServer, initSentryEdge } from '@/lib/observability/sentry';

/**
 * OpenTelemetry registration for observability.
 *
 * This function is called automatically by Next.js at build time
 * to register the OTel instrumentation for tracing and monitoring.
 *
 * @see https://vercel.com/docs/observability/otel-integration
 */
export function register() {
  // Validate environment variables at startup to fail fast on missing config
  validateEnvVars();

  registerOTel({
    serviceName: 'ai-hvac-agent',
  });

  // DEGRADE-SAFE error tracking: both inits no-op unless SENTRY_DSN is set, so
  // a deploy without Sentry configured behaves exactly as before.
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
  Sentry.captureRequestError(err, request, context);
};
