/**
 * Client-side instrumentation (Next 15.3+ convention).
 *
 * DEGRADE-SAFE: initSentryClient() no-ops unless NEXT_PUBLIC_SENTRY_DSN is set,
 * so with no DSN the browser bundle initializes nothing and behaves as today.
 */
import * as Sentry from '@sentry/nextjs';
import { initSentryClient } from '@/lib/observability/sentry';

initSentryClient();

// Wire client-side router navigation into Sentry tracing (inert without a DSN).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
