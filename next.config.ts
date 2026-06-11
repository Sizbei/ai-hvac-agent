import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents temporarily disabled due to Next.js 16 + icon metadata conflict
  // cacheComponents: true,
  experimental: {
    instantNavigationDevToolsToggle: true,
  },
  serverExternalPackages: ["pino", "pino-pretty"],
  // Baseline security headers for EVERY route — including ones the edge
  // middleware (src/proxy.ts) doesn't match (e.g. "/", "/chat", "/widget.js").
  // We set only universally-safe headers here; frame control (X-Frame-Options
  // for admin vs. per-org frame-ancestors for /embed) stays in the middleware,
  // which runs after and intentionally varies it per route.
  async headers() {
    return [
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

export default nextConfig;
