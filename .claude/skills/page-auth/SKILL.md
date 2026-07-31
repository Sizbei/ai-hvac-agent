---
name: page-auth
description: Use when working on admin login, forgot-password, or invite-accept pages — Google OIDC vs password mode, OIDC error mapping, non-enumerating flows.
---

# Auth (/admin/login · /admin/forgot-password · /admin/invite/[token])

**Purpose:** staff authentication entry points. Login is Google-only when configured;
the password form is the fallback and break-glass override. Forgot-password is an
honest recovery guide (no self-serve email reset exists). Invite-accept lets a newly
invited staff member set their name and password via a tokenized link.

**Files:** login page `src/app/admin/login/page.tsx` · login form
`src/app/admin/login/login-form.tsx` · mode resolver
`src/lib/auth/login-mode.ts` · OIDC config `src/lib/auth/google-oidc.ts` ·
Google login helpers `src/lib/auth/google-login.ts` ·
Google OIDC routes `src/app/api/auth/google/start/route.ts`
`src/app/api/auth/google/callback/route.ts` ·
password login route `src/app/api/auth/login/route.ts` ·
forgot-password page `src/app/admin/forgot-password/page.tsx` ·
forgot-password form `src/app/admin/forgot-password/forgot-password-form.tsx` ·
invite page `src/app/admin/invite/[token]/page.tsx` ·
invite accept form `src/app/admin/invite/[token]/accept-form.tsx` ·
invite queries `src/lib/admin/invites.ts` ·
invite accept route `src/app/api/auth/invite/accept/route.ts` ·
authz `src/lib/auth/authz.ts`

**Data flow:** login page is a server component that reads OIDC env config
(`getGoogleOidcConfig()`) and `resolveLoginMode()` to pick `"google"` or `"password"`.
OIDC errors arrive as `?error=` codes in the redirect; `login-form.tsx` maps them to
generic strings via `OIDC_ERROR_MESSAGES` (never exposes internal detail).
Invite-accept page resolves the token server-side via `resolveInviteByToken`; any
failure (unknown/expired/used/revoked) renders one generic "no longer valid" card —
no distinction surfaced. The `AcceptForm` receives the token, email (read-only), and
role; it calls `/api/auth/invite/accept` to set name + hashed password.

**Invariants:**
- `resolveLoginMode` returns `"password"` if Google is not configured OR if
  `?password=1` is present — the break-glass override must always work.
- Forgot-password page NEVER claims to send a reset email (no self-serve reset
  exists — staff passwords are reset by an admin in settings). Page copy must remain
  honest about this.
- Invite-accept shows the SAME error card regardless of why the token failed (expired,
  used, revoked, unknown) — no enumeration of which state it is in.
- `"go to sign in"` is the canonical CTA copy on auth error states (not "login").
  Follow the admin-pages copy canon: "sign in" (not "login").

**Gotchas:**
- The homepage demo-login link must carry `?password=1` — the login page defaults to
  Google-only mode without it; a plain `/admin/login` link dead-ends the demo creds.
- Google OIDC is gated by `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`
  env vars; the "Continue with Google" button NEVER renders when unconfigured (avoid a
  dead button).
- Tokens are SHA-256 hashed at rest (same pattern as estimate/portal tokens); the
  plaintext is single-use and returned only at invite creation time.

**Verify changes:**
- `npx vitest run src/lib/auth/login-mode.test.ts src/lib/auth/google-oidc.test.ts`
- `npx vitest run src/app/api/auth/invite/accept/route.test.ts`
- Gate: `npx tsc --noEmit`
