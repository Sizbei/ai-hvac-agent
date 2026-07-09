# Google-only admin login + production credential lockdown

**Date:** 2026-07-10 · **Status:** approved (user confirmed design in chat, provided OAuth client)

## Problem

Production shared a database with dev until 2026-07-09, so the dev seed users
are live in production: `admin@demo-hvac.com` (active **admin**, password
`admin123` — the password is written in `src/lib/db/seed.ts`) plus three
`tech123` technicians. Google OIDC login exists in code but was never
configured (no `GOOGLE_*` env vars anywhere), so the weak demo password is the
only way into the production admin console — and the owner's own super_admin
account (Google-only, no password) cannot log in at all.

## Decisions (user-approved)

1. **Google-only login UI.** The admin login page shows a single "Continue
   with Google" action. The email/password form renders only when:
   - Google OIDC is **not configured** (`getGoogleOidcConfig() === null`) —
     keeps dev, preview, and a mid-setup production usable; makes deploy order
     safe; or
   - the URL carries `?password=1` — break-glass if Google is ever down.
   The `/api/auth/login` password endpoint is unchanged.
2. **OAuth config.** One Google OAuth client (user-created). Vercel
   Production: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_OIDC_REDIRECT_URI=https://ai-hvac-agent-lovat.vercel.app/api/auth/google/callback`.
   Vercel Preview: ID + secret only (no redirect URI → password fallback,
   since per-deploy preview URLs can't be registered with Google). Local dev:
   all three in `.env.local` with the localhost callback.
3. **Lockdown — only after the owner verifies Google sign-in on production:**
   set `is_active = false, password_hash = NULL` for the four
   `*@demo-hvac.com` users in the production DB. The development branch keeps
   them for local testing. Ordering is the lockout guard.

## Implementation

- `src/app/admin/login/page.tsx` — server component reads `searchParams`
  (Promise, Next 16) and OIDC config; computes the mode via a pure helper.
- `src/lib/auth/login-mode.ts` — `resolveLoginMode({ googleEnabled,
  passwordParam })` → `'google' | 'password'`. Pure; unit-tested (repo policy:
  no RTL/jsdom, pure-helper tests only).
- `src/app/admin/login/login-form.tsx` — renders per mode. Google mode: brand
  card + prominent Google button, no fields, no demo placeholder. Password
  mode: existing form (demo placeholder removed) + Google button when
  configured. OIDC `?error=`/`?notice=` alerts render in both modes.

## Out of scope

Technician login (`/tech-login`, separate session/API), signup flow, Calendar
OAuth (separate redirect URI), password-reset UX.

## Verification

Unit tests for the helper; `npm run lint` + `npm run build`; manual check of
the three page states; owner signs in with Google on production; lockdown SQL
runs; `admin@demo-hvac.com`/`admin123` rejected afterward.
