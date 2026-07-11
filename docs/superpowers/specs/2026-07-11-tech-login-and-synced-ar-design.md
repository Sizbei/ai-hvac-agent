# Technician sign-in (set-password links + Google) & synced-AR aging buckets

**Date:** 2026-07-11 · **Status:** approved in chat ("Both link + Google")

## Problem

The 5 real technicians were created by the FieldPulse tech sync with
`password_hash = NULL` ("technicians authenticate via Fieldpulse"), but the
`/tech` portal needs them to sign in here and `/tech-login` is password-only —
so no technician can log in. One tech has an iCloud email, ruling out a
Google-only solution. Separately, `/admin/operations` shows synced AR as a
single unbucketed total even though mirrored invoices now carry real due dates.

## Design

### 1. Set-password links — extend staff invites to claim existing users

Today `createInvite` refuses when a user with the email exists, and
`acceptInvite` dead-ends with `email_conflict`. Extension:

- `createInvite`: when the email matches an existing org user that is
  **active, password-less (`password_hash IS NULL`), and has the invite's
  role**, the invite is allowed (it is a credential-setup link). Other
  existing-user cases keep returning `email_conflict`. Seat-limit check is
  SKIPPED for this case (the user already holds a seat).
- `acceptInvite`: same match test; on match, set `password_hash =
  bcrypt(input.password)` on the existing user (keep their name; ignore the
  form name) and claim the invite. On mismatch keep today's `email_conflict`.
  Password-bearing users are never touched — a link can't overwrite live
  credentials.
- Accept page: after a technician-role accept, point the user at `/tech-login`
  (admins keep the current admin-login redirect).

Admin workflow: create an invite for the tech's email in the existing team UI,
copy the link, send it however they like.

### 2. Google sign-in for technicians — role-aware OIDC callback

Single existing flow (`/api/auth/google/start` → `/callback`), no new Google
console config. `resolveGoogleLogin` currently rejects non-admin-tier users;
it becomes role-aware:

- Verified identity matching an **active admin-tier** user → admin session →
  `/admin` (unchanged, including google_id linking + sub-mismatch rejection).
- Verified identity matching an **active technician** → TECH session
  (`hvac_tech_session` via `createTechSession`) → `/tech/jobs`. Same
  google_id linking and sub-mismatch guard.
- No/inactive user → `no_account` (unchanged).

`/tech-login` becomes a server page + client form (mirroring the admin login
structure) and shows "Continue with Google" when OIDC is configured. The tech
session cookie switches `sameSite` strict → lax with the same rationale as the
admin cookie (the Google-originated redirect chain drops strict cookies; lax
still blocks cross-site POSTs to /api/tech/*).

### 3. Operations synced-AR buckets

`operations-metrics-queries.ts`: the synced-AR single aggregate becomes the
same 0-30 / 31-60 / 60+ buckets as native AR, aged by
`COALESCE(due_date, issued_at, created_at)`. Native buckets untouched (native
rows have NULL due dates; behavior identical). The operations page renders the
synced buckets with the same visual treatment as native.

## Out of scope

SMS OTP login, self-serve password reset, tech-side Google account management,
FP tech-sync changes.

## Verification

Unit tests: invites accept-claims-existing-user branch (allowed + refused
cases), resolveGoogleLogin technician path, ops bucket SQL shape. Manual:
create a link for a tech → set password → /tech-login works; Google login as a
technician lands in /tech/jobs; admin Google login unchanged.
