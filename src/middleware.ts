/**
 * Next.js middleware entry point.
 *
 * Next only loads middleware from `middleware.ts` at the project/src root with a
 * `default` export (and an optional `config`). The actual logic lives in
 * `proxy.ts` (kept separate for testability) — re-export it here so the edge
 * gating (admin session checks, /embed frame-ancestors, security headers) is
 * ACTUALLY registered. Without this file the middleware-manifest is empty and
 * none of proxy.ts runs.
 */
export { proxy as default, config } from "./proxy";
