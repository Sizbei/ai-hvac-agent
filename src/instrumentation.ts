import { registerOTel } from '@vercel/otel';

/**
 * OpenTelemetry registration for observability.
 *
 * This function is called automatically by Next.js at build time
 * to register the OTel instrumentation for tracing and monitoring.
 *
 * @see https://vercel.com/docs/observability/otel-integration
 */
export function register() {
  registerOTel({
    serviceName: 'ai-hvac-agent',
  });
}
