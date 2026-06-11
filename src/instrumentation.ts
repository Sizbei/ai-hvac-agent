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
export function register() {
  // Validate environment variables at startup to fail fast on missing config
  validateEnvVars();

  registerOTel({
    serviceName: 'ai-hvac-agent',
  });
}
