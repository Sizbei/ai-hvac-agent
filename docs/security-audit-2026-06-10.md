# Security Audit — ai-hvac-agent

**Date:** 2026-06-10
**Method:** Three parallel `security-reviewer` subagents over the whole codebase (auth/sessions/multi-tenancy; injection/secrets/PII/webhooks; deps/config/headers/widget). Read-only analysis.

## Headline

**0 CRITICAL, 0 HIGH.** The codebase is in strong shape. Multi-tenant isolation,
cryptography, webhook signature verification, secret handling, CSRF, and error
handling are all clean. Findings are MEDIUM and below, mostly hardening.

## Findings & disposition

| # | Severity | Finding | File | Disposition |
|---|----------|---------|------|-------------|
| 1 | MEDIUM | In-memory rate limiter is per-instance — login brute-force limit (5/min) not enforced across concurrent Vercel instances | `src/lib/rate-limit.ts` | Documented; needs shared store (Vercel KV) — tracked, larger infra change |
| 2 | MEDIUM | Several admin mutation endpoints lack rate limiting (customers POST, technicians POST/PATCH, widget-keys DELETE, settings PATCH, faqs POST/PATCH/DELETE) | various `/api/admin/*` | **FIX inline** — add `slidingWindow(adminMutation)` |
| 3 | MEDIUM | Admin read endpoints lack rate limiting (audit-log, stats, ai-insights, ops-insights) | `/api/admin/*` | **FIX inline** — add `slidingWindow(adminRead)` |
| 4 | MEDIUM | `next.config.ts` sets no fallback security headers; `/`, `/chat`, `/widget.js` outside middleware matcher get none (no nosniff on widget.js) | `next.config.ts`, `src/proxy.ts` | **FIX inline** — add nosniff/HSTS fallback |
| 5 | LOW | JWT not invalidated on account deactivation/role change — up to 24h stale window | `src/lib/auth/session.ts` | Documented; accepted trade-off for short-lived JWT (could add DB re-check) |
| 6 | LOW | `secure` cookie flag conditional on NODE_ENV=production | `src/lib/auth/session.ts` | Accept (Vercel previews are HTTPS); low risk |
| 7 | LOW | `super_admin` enum value exists but login excludes it — silent lockout | `schema.ts`, login route | **FIXED by this PR** (super_admin tier work) |
| 8 | LOW | Unauthenticated logout accepted (no-op cookie clear) | `src/app/api/auth/logout/route.ts` | **FIX inline** — guard on session presence |
| 9 | LOW | Missing HSTS header | `src/proxy.ts` | **FIX inline** with #4 |
| 10 | LOW | LIKE metacharacters (`%`/`_`) not escaped in conversation search — full-scan/ReDoS, NOT SQLi (still parameterized) | `src/lib/admin/conversation-queries.ts:130` | **FIX inline** — mirror queries.ts:123 escape |
| 11 | LOW (info) | Brand fields interpolated verbatim into LLM system prompt — trust-boundary, becomes HIGH if multi-tenant self-serve | `src/lib/ai/system-prompt.ts` | Documented; harden before multi-tenant self-serve |
| 12 | MODERATE (dep) | postcss XSS advisory via `next@16.2.6` (build-time) | dependency | Monitor; upgrade next when patch ships |
| 13 | MODERATE (dep) | esbuild dev-server CORS (dev-only, via drizzle-kit) | dev dependency | No prod risk; low urgency |
| 14 | INFO | Seed uses weak demo passwords (bcrypt-hashed; dev-only) | `src/lib/db/seed.ts` | Add "never run against prod" warning |

## Verified clean (explicit PASS)

- **Multi-tenant isolation** — all 17 admin `[id]` routes scope every query/mutation by `session.organizationId`. No cross-tenant read/write found.
- **Authorization** — every admin route calls `getAdminSession()` → 401 on null (32 routes). `verifyToken` hard-rejects non-admin roles.
- **Crypto** — AES-256-GCM, random 12-byte IV per ciphertext, 16-byte auth tag, separate HMAC-SHA256 blind-index key (domain-separated). No `createCipher`/ECB/static-IV.
- **Webhooks** — Twilio (HMAC-SHA1, timing-safe, fail-closed) and HCP (HMAC-SHA256 over raw body, timing-safe) verified before side effects. TTS uses short-lived HMAC token.
- **Secrets** — all via `process.env`; none hardcoded. `.env*` gitignored except `.env.example`. Pino logger redacts email/phone/name/address/password/token/cookie/authorization.
- **SSRF** — no user-controlled fetch URLs (Photon endpoint hardcoded, input only as query param).
- **XSS** — `innerHTML` only on static SVG constants; DB fields via safe attribute/style setters; Zod-validated on write.
- **CSRF** — admin cookie `SameSite=strict`; customer session `SameSite=None` guarded by same-origin Origin allowlist + JSON content-type, fails closed on absent Origin.
- **Error disclosure** — `api-response.ts` serializes only caller-supplied message/code; no raw `error.message`/stack/`JSON.stringify(error)` reaches clients.
- **Clickjacking** — admin routes `X-Frame-Options: DENY`; embed framing scoped to widget routes via per-org `frame-ancestors`.

## Inline fixes applied in this PR

See commits on `feat/google-login-super-admin`:

- **#2 FIXED** — rate limiting added to all admin mutation endpoints.
- **#3 FIXED** — rate limiting added to all admin read endpoints (every admin
  route now has `slidingWindow`; 23 handler methods across 15 files).
- **#4 FIXED** — `next.config.ts` now sets baseline headers (nosniff,
  Referrer-Policy, HSTS) for every route, covering `/`, `/chat`, `/widget.js`.
- **#7 FIXED** — `super_admin` role tier added with a real login path.
- **#9 FIXED** — HSTS added to the middleware `addSecurityHeaders` and the
  config fallback.
- **#10 FIXED** — conversation search now escapes LIKE metacharacters.
- **#14 FIXED** — `seed.ts` carries a prominent "DEV-ONLY, never run against
  prod" warning.

Documented / not changed (with rationale):

- **#1** (in-memory rate limiter per-instance) — needs a shared store (Vercel
  KV); infra change, follow-up.
- **#5** (JWT not invalidated on deactivation, 24h window) — accepted trade-off
  for short-lived JWT; would need a DB re-check per request.
- **#6** (`secure` cookie conditional on NODE_ENV) — accepted (Vercel previews
  are HTTPS).
- **#8** (unauthenticated logout) — left as-is: deleting a `SameSite=strict`
  cookie is already CSRF-safe and clearing a non-existent cookie is a harmless
  no-op; a session check would add complexity with no real security gain.
- **#11** (brand fields in system prompt) — trust-boundary; harden before
  multi-tenant self-serve.
- **#12/#13** (postcss/esbuild moderate advisories) — dependency upgrades,
  no prod-exploitable path.
