/**
 * Centralized, DEGRADE-SAFE Sentry configuration.
 *
 * The whole module is a no-op unless a DSN is present:
 *   - Server / edge init is guarded on SENTRY_DSN.
 *   - Browser init is guarded on NEXT_PUBLIC_SENTRY_DSN.
 *
 * With NO DSN set, `initSentry*()` returns immediately and `Sentry.*` calls
 * elsewhere are inert (the SDK no-ops when never initialized). This keeps the
 * build and runtime identical to today's behavior when Sentry is not configured.
 *
 * PII scrubbing reuses the logger's redaction key-list philosophy
 * (phone / email / name / address / token): `sendDefaultPii` is off and a
 * `beforeSend` hook strips matching keys from the event before it leaves the
 * process.
 */
import * as Sentry from "@sentry/nextjs";

// Mirror of the logger's PII_FIELDS (src/lib/logger.ts). Kept as a local copy
// (rather than importing the logger) so this module stays free of the pino /
// transport dependency chain and is safe to load in the edge runtime.
const PII_KEYS = [
  "email",
  "phone",
  "name",
  "address",
  "customername",
  "customerphone",
  "customeremail",
  "passwordhash",
  "password",
  "token",
  "sessiontoken",
  "cookie",
  "authorization",
] as const;

const REDACTED = "[REDACTED]";

function looksLikePii(key: string): boolean {
  const lower = key.toLowerCase();
  return PII_KEYS.some((pii) => lower === pii || lower.includes(pii));
}

/**
 * Recursively redact PII-looking keys from an arbitrary value. Depth-bounded to
 * avoid pathological deep/cyclic payloads slowing the hot path.
 */
function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = looksLikePii(key) ? REDACTED : scrubPii(val, depth + 1);
  }
  return out;
}

/**
 * Shared options applied to every runtime (server, edge, client).
 */
function commonOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    // Never let the SDK attach default PII (IP, cookies, user, etc.).
    sendDefaultPii: false,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    // Tracing is opt-in via env; default off so we don't change perf/cost
    // characteristics or quota usage without an explicit decision.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    beforeSend(event) {
      // Strip PII the SDK or user code may have attached.
      if (event.request?.headers) {
        event.request.headers = scrubPii(event.request.headers) as Record<
          string,
          string
        >;
      }
      if (event.request?.cookies) {
        event.request.cookies = scrubPii(event.request.cookies) as Record<
          string,
          string
        >;
      }
      if (event.request?.data) {
        event.request.data = scrubPii(event.request.data);
      }
      if (event.extra) {
        event.extra = scrubPii(event.extra) as Record<string, unknown>;
      }
      if (event.contexts) {
        event.contexts = scrubPii(event.contexts) as typeof event.contexts;
      }
      // Drop user identity entirely (we never want to ship it).
      delete event.user;
      return event;
    },
  };
}

/**
 * Initialize Sentry for the Node.js server runtime. No-op without SENTRY_DSN.
 */
export function initSentryServer(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init(commonOptions(dsn));
}

/**
 * Initialize Sentry for the Edge runtime. No-op without SENTRY_DSN.
 */
export function initSentryEdge(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init(commonOptions(dsn));
}

/**
 * Initialize Sentry for the browser. No-op without NEXT_PUBLIC_SENTRY_DSN.
 */
export function initSentryClient(): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    ...commonOptions(dsn),
    // Browser release uses the same commit SHA, exposed via NEXT_PUBLIC_*.
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  });
}

/**
 * Whether server-side Sentry is configured. Safe to call anywhere.
 */
export function isSentryServerEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}
