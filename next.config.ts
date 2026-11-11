import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // cacheComponents temporarily disabled due to Next.js 16 + icon metadata conflict
  // cacheComponents: true,
  serverExternalPackages: ["pino", "pino-pretty"],
  // Every admin route is dynamic (the layout reads the session cookie), and a
  // dynamic page's payload is not reused by default — so returning to a page
  // seconds later waited on the server again before anything painted. Reuse
  // it for 30 s; pages fetch their own data client-side and still revalidate.
  experimental: { staleTimes: { dynamic: 30 } },
  // Baseline security headers for EVERY route — including ones the edge
  // middleware (src/proxy.ts) doesn't match (e.g. "/", "/chat", "/widget.js").
  // We set only universally-safe headers here; frame control (X-Frame-Options
  // for admin vs. per-org frame-ancestors for /embed) stays in the middleware,
  // which runs after and intentionally varies it per route.
  async headers() {
    return [
      // Brand and tutorial files rarely change: let browsers keep them for a day
      // (and serve stale for a week while refreshing) instead of revalidating
      // on every page view.
      {
        source: "/(brand|tutorial)/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

// DEGRADE-SAFE wrapper: only engage Sentry's build plugin when a DSN is set.
// With NO SENTRY_DSN, we export the plain nextConfig untouched, so the build is
// identical to before Sentry was added (no plugin, no source-map step). Runtime
// error capture still works via instrumentation.ts when a DSN is later set —
// only build-time source-map UPLOAD requires SENTRY_AUTH_TOKEN/ORG/PROJECT.
const config: NextConfig = process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      // Upload source maps only when an auth token is available; otherwise the
      // plugin runs but skips the upload (no build failure on missing token).
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      // Keep client bundles lean; tree-shake Sentry logger statements.
      disableLogger: true,
    })
  : nextConfig;

export default config;
