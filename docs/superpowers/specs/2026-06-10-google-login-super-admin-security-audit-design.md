# Design: Google Login + super_admin tier + Security Audit

**Date:** 2026-06-10
**Status:** Approved (pending spec review)

## Goals

1. Add a `super_admin` role tier (top role within an org).
2. Add "Sign in with Google" (OIDC) to the admin suite, pre-provisioned only.
3. Provision `rchen.workmail@gmail.com` as a `super_admin` (Google-only, no password).
4. Run a full security audit; fix CRITICAL/HIGH inline; report the rest.

## Decisions (locked)

- **super_admin scope:** org-scoped. It is the highest role *within its organization*
  (manages admins, protected from demotion/deletion), but **every query stays filtered
  by `session.organizationId`** — the multi-tenant isolation invariant is unchanged.
  No "god mode" / cross-org access.
- **Google login policy:** pre-provisioned only. Google authenticates identity; it
  NEVER auto-creates accounts. No matching active admin/super_admin user row → denied.
- **rchen.workmail@gmail.com:** seeded as `super_admin`, `passwordHash = NULL`
  (Google-only), `isActive = true`, in the existing demo org.

## Part 1 — super_admin role tier

### Schema (`src/lib/db/schema.ts`, `users` table)

- `role` enum: `["admin","technician"]` → `["super_admin","admin","technician"]`.
  Default stays `"technician"`.
- Add `googleId text` — nullable; **unique** (one Google account ↔ one user).
- `passwordHash`: `.notNull()` → **nullable**. A NULL hash means password login is
  impossible for that user (Google-only). The password login route MUST treat a NULL
  hash as "not eligible" (compare against DUMMY_HASH, generic 401) — no NULL ever
  reaches `bcrypt.compare` as the stored hash.

Migration: drizzle-kit generate + a hand-checked enum alter (Postgres enum changes
via `text` column with a CHECK-style enum are drizzle-managed here since `role` is a
`text(... {enum})`, not a pgEnum — so it's a plain column, no enum-type migration).
Run `npm run db:migrate` after (Vercel build does NOT run migrations — see memory).

### Session / authorization

- `AdminSessionPayload.role`: `"admin"` → `"super_admin" | "admin"`.
- `verifyToken` (`config.ts`): accept role ∈ {super_admin, admin}; reject technician
  and anything else (unchanged hard-fail posture).
- New `src/lib/auth/authz.ts`:
  - `isSuperAdmin(session)` predicate.
  - `requireSuperAdmin(session)` → throws/returns 403 helper for routes.
- Staff management (`staff-queries.ts` + `/api/admin/staff/[id]`):
  - Only a super_admin may create/promote/demote/deactivate an **admin** or
    **super_admin**. A normal admin may only manage technicians.
  - A super_admin is **protected**: cannot be demoted/deactivated/deleted by anyone
    who is not a super_admin; the existing "last admin" guard extends to "last
    super_admin" (cannot remove the final super_admin in an org).
  - Self-demote/self-deactivate guard stays.

## Part 2 — Google login (OIDC)

Separate flow from the existing Calendar OAuth (different scopes + redirect URI),
reusing `oauth-state.ts` CSRF-state pattern.

### New: `src/lib/auth/google-oidc.ts`

- Scopes: `openid email profile`.
- `getGoogleOidcConfig()` — reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_OIDC_REDIRECT_URI`; returns null if any unset (safe degrade).
- `buildOidcConsentUrl(config, state, nonce)`.
- `exchangeCodeForIdToken(config, code, fetchImpl)` → returns raw `id_token`.
- `verifyGoogleIdToken(idToken, config, nonce)` — verify signature against Google's
  JWKS (`jose` `createRemoteJWKSet` for `https://www.googleapis.com/oauth2/v3/certs`),
  check `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` === clientId,
  `exp`, and the `nonce`. Return `{ email, emailVerified, sub, name }`.

### Routes

- `GET /api/auth/google/start`:
  - If OIDC not configured → 404.
  - Mint state + nonce, set httpOnly cookies (short-lived), redirect to consent URL.
- `GET /api/auth/google/callback`:
  - Rate-limit per IP (reuse sessionCreate budget).
  - Verify `state` cookie (CSRF) — mismatch/missing → reject.
  - Exchange code → id_token; verify id_token + nonce.
  - Require `email_verified === true`.
  - Look up `users` by email (case-insensitive). Eligible = exists ∧ isActive ∧
    role ∈ {admin, super_admin}.
  - Eligible → set `users.googleId` if not already set (and ensure it matches `sub`
    if it is — a different sub for the same email is rejected), create admin session,
    redirect `/admin`.
  - Not eligible → redirect `/admin/login?error=no_account` (generic; no enumeration,
    no timing oracle needed since this isn't password-guessing but keep messaging
    uniform).
- Clear the state/nonce cookies on callback regardless of outcome.

### UI

- `/admin/login`: add "Sign in with Google" button (only rendered when a new
  `/api/auth/google/start` is reachable — gate via a server-read env flag passed to
  the page, or render unconditionally and let 404 handle it; prefer the env flag so
  we don't show a dead button).
- `?error=no_account` shows a generic "This Google account isn't authorized" message.

### Env / setup (documented in spec + .env.example)

- `GOOGLE_OIDC_REDIRECT_URI=https://<host>/api/auth/google/callback`
- Reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- Google Cloud Console: add the callback to Authorized redirect URIs; ensure the
  OAuth consent screen has email/profile scopes.

## Part 3 — Seed rchen.workmail@gmail.com

Idempotent seed (script `src/lib/db/seed-super-admin.ts`, runnable via an npm script,
AND a SQL migration upsert so prod gets it on `db:migrate`):

```
upsert into users (email='rchen.workmail@gmail.com')
  set role='super_admin', isActive=true, passwordHash=NULL, name='Raymond Chen',
      organizationId=<demo org id>
  on conflict (org,email) do update set role='super_admin', isActive=true
```

Resolve the demo org id at runtime (the seed already knows it) — do NOT hardcode a UUID.

## Part 4 — Security audit

- Parallel `security-reviewer` subagents over: auth/session/JWT, the NEW OIDC flow,
  secret handling, multi-tenant org-scoping (leak hunt), injection (drizzle params),
  encrypted-PII columns, rate-limit coverage, CSRF, the public chat/voice/SMS webhooks.
- Output: `docs/security-audit-2026-06-10.md`, severity-ranked.
- Fix CRITICAL + HIGH inline (re-review after). List MEDIUM/LOW for user decision.

## Testing

- Unit: `google-oidc.ts` (id_token verify happy + tampered + wrong-aud + bad-nonce +
  unverified-email), `authz.ts` predicates, login route NULL-hash rejection,
  callback route (state mismatch, no-account, eligible, sub-mismatch).
- Integration: staff-management authorization matrix (admin vs super_admin × target
  role), last-super_admin guard.
- All via vitest with injected `fetchImpl` / mocked JWKS — no network.
- Keep the suite green (currently 1439 tests) + tsc + lint clean + build.

## Non-goals

- No cross-org access. No auto-provisioning. No password reset via Google. No change
  to the customer-facing chat/voice auth (those are sessionless by design).

## Rollout

Branch `feat/google-login-super-admin`. Commit in logical chunks (schema+migration,
authz, OIDC lib, routes, UI, seed, audit-fixes). Verify gate green before merge.
Run `npm run db:migrate` against the deployed DB after merge (Vercel won't).
