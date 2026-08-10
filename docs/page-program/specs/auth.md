# auth — target-state spec

`/admin/login` · `/admin/forgot-password` · `/admin/invite/[token]` ·
`/signup` · `/tech-login` — every unauthenticated entry point into the app:
admin/technician sign-in, password recovery guidance, team-invite claim, and
self-serve org signup.

## 1. Purpose

Get the right person into the right session (admin, technician, or a brand
new org's owner) with no account enumeration, no cross-role bleed, and no
route that can be tricked into minting a session for someone other than the
person actually present in the browser. One job: gate every other page in
the app behind a correct identity check.

## 2. Brainstorm

- **Google-only login with a password break-glass fallback** — shipped
  (`resolveLoginMode`, `login-mode.ts:11-18`: password iff Google isn't
  configured OR `?password=1`). Necessary so a Google outage never locks
  everyone out. verified.
- **Pre-provisioned-only Google login (no auto-create)** — shipped
  (`google-login.ts:42-46`). Rejected: auto-create on first verified Google
  sign-in — that would let anyone with a Gmail address self-admit to an org
  just by knowing its login URL. verified.
- **Separate self-serve signup with its own OIDC cookies** — shipped
  (`google-oidc-state.ts:17-26`). Necessary: login and signup can be open in
  two tabs at once; shared state/nonce cookies would let one flow clobber
  the other. verified.
- **Tokenized, hashed, single-use, expiring team invites** instead of
  emailed magic links — shipped (`invites.ts:13-31`). No email-deliverability
  dependency; a copyable link is easier to hand a new hire directly. verified.
- **One generic "no longer valid" card for every invite failure reason** —
  shipped (`invite/[token]/page.tsx:41-53`). Rejected: distinguishing
  expired/used/revoked — that lets an attacker probe which invites exist.
  verified.
- **Self-serve email password reset** — rejected. No outbound-email
  pipeline is wired to this flow; admin-resets-from-Settings is simpler and
  the forgot-password page is honest about it instead of faking it. verified
  (`forgot-password-form.tsx:19-23`).
- **CAPTCHA/bot-challenge on login forms** — rejected. No evidence of
  credential-stuffing abuse, and per-IP rate limiting already exists
  (5/min). Real UX cost for an undemonstrated threat.
- **Per-user token versioning to revoke sessions on password reset** — NOT
  shipped; the code's own comment flags it as a tracked follow-up
  (`session-revocation.ts:22-24`, verified). Promoted to Gauth-2.
- **Same-origin/CSRF guard on the auth POST routes** — NOT shipped, despite
  the identical guard (`src/lib/session-csrf.ts`) already used on other
  session-mutating endpoints. Promoted to Gauth-1.

## 3. Current state

Five surfaces, five session outcomes (verified — read in full):

- **Admin login** — `login/page.tsx:16-21` picks `"google"`/`"password"`
  via `resolveLoginMode`. `login-form.tsx` renders the Google button
  (`:81-93`) or `PasswordForm` (`:116-196`), which POSTs JSON to
  `/api/auth/login`.
- **Password login route** — `api/auth/login/route.ts:26-117`. Rate-limited
  5/min/IP (`:30-42`). Runs `bcrypt.compare` against a real hash *or* a
  `DUMMY_HASH` for every ineligible case (no user / wrong role / inactive /
  Google-only, `:68-94`) so timing and response are identical either way.
  On success mints the admin session; client navigates to
  `/admin/requests`.
- **Google OIDC login** — `/api/auth/google/start` (`:30-71`) mints
  `state`+`nonce` in short-lived httpOnly cookies, 404s if unconfigured.
  `/api/auth/google/callback` (`:53-133`) constant-time-compares `state`
  (`:37-41,83`), exchanges the code, verifies the id_token against Google's
  JWKS (`google-oidc.ts:139-171`), requires `email_verified === true`
  (`:97-99`), then `resolveGoogleLogin` (`google-login.ts:31-89`) denies
  unless a matching **active** user row exists, links `google_id` on first
  login, and rejects a `sub` mismatch on the same email (account-takeover
  guard, `:48-52`). The resolved `kind` picks which of two non-aliasing
  session cookies gets minted (`callback/route.ts:111-117`).
- **Session cookies** — `hvac_admin_session` / `hvac_tech_session` are
  distinct HS256 JWTs (`AUTH_SECRET`, min 32 chars, fail-fast at boot,
  `env-validation.ts:179-181`), 24h, `httpOnly`, `secure: true`,
  `sameSite: "lax"` (deliberate — `"strict"` drops the cookie on the
  Google-redirect follow-up, `session.ts:19-24`). Tech token adds
  `aud: "hvac-tech"` (`tech-config.ts:16,42`); `verifyToken` requires
  `role` to be `"super_admin"`/`"admin"`, never `"technician"`
  (`config.ts:29-59`). Every read also calls `isSessionUserCurrent`
  (`session-revocation.ts:41-71`, 30s positive-cache) which denies a
  deactivated/demoted/deleted user despite a crypto-valid token, and fails
  OPEN on a DB error (`:64-70`, documented tradeoff).
- **Forgot password** — entirely client-side, no network call: submitting
  flips to a recovery panel naming the same three steps (Google / admin
  reset in Settings → Staff / email support) for **any** input, never
  confirming an account exists (`forgot-password-form.tsx:19-23,44-53`).
- **Team invite claim** — `invite/[token]/page.tsx:37-78` resolves the
  token server-side (`resolveInviteByToken`, `invites.ts:286-327`, looked
  up by SHA-256 hash, `:52-54`), one generic card for every failure reason
  (`:41-68`). Valid token renders `AcceptForm` (email read-only, 8-char
  min password both sides — `accept-form.tsx:39`, `accept/route.ts:28`).
  `POST /api/auth/invite/accept` (`:31-120`) is rate-limited 5/min/IP,
  validates the token shape (`^[0-9a-f]{64}$`), collapses every failure to
  one generic 400 (`:68-76`). `acceptInvite` (`invites.ts:368-495`) takes
  the role **only** from the trusted invite row; is
  create-user-then-claim ordered to survive `neon-http`'s lack of
  transactions (`:359-367`); and promotes to `super_admin` only when the
  invite email matches the org's stored `ownerEmail`, then consumes it so
  it can't re-fire (`:423-467`). `canAssignRole` blocks an `admin` actor
  from ever creating an `admin`/`super_admin` invite (`authz.ts:92-103`,
  enforced at `invites.ts:106` and `staff-queries.ts:194,378`).
- **Self-serve signup** — `signup/page.tsx` gates the button on base OIDC
  config plus `GOOGLE_OIDC_SIGNUP_REDIRECT_URI`. `signup-form.tsx` is a
  real `<form method="POST">` (top-level redirect to Google, not `fetch`).
  `/api/auth/signup/start` (`:53-141`) validates the business name
  (1–100 chars), signs it into a short-lived `hvac_signup_intent` cookie,
  and uses signup-specific state/nonce cookie names so a concurrent login
  tab can't collide. `/api/auth/signup/callback` (`:81-191`) verifies the
  same way login does, then `provisionOrgWithOwner` (`signup.ts:55-131`):
  a **global** cross-org email check (`:63-69`) sends any existing email to
  login instead of provisioning a second org; a new email gets a new org +
  `super_admin` owner in one batch, `ownerEmail` left `null` (`:72-84`).
- **Technician login** — `tech-login/page.tsx` + `tech-login-form.tsx`,
  deliberately outside the `/tech` session-gated layout (no redirect loop
  when signed out). Password path posts to `/api/auth/tech/login`
  (`:33-109`, same dummy-hash pattern) but requires `role === "technician"`
  exactly (`:70-76`). Google path reuses `/api/auth/google/start`; the
  callback's role-aware `kind` mints the tech session.
- **Role hierarchy** — `authz.ts:1-104`: `super_admin > admin >
  technician` via `canManageRole`/`canAssignRole` (never assignable to
  `super_admin` through invite/assign, `:100`), plus env-allowlisted
  `isPlatformAdmin` (fails closed unless `PLATFORM_ADMIN_EMAILS` AND
  `PLATFORM_ORG_ID` are set and the session's own org matches, `:48-57`).
- **Logout** — `/api/auth/logout` clears only the admin cookie;
  `/api/auth/tech/logout` clears only the tech cookie — two routes so a
  technician on a shared device can actually sign out.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gauth-1: No same-origin/CSRF guard on the three session-minting POST routes | P1 | `api/auth/login/route.ts`, `api/auth/tech/login/route.ts`, `api/auth/invite/accept/route.ts` never import `isSameOriginRequest`/`hasJsonContentType` (verified full-file read + grep — every other session-mutating route in the app uses this guard). All three parse the body with `request.json()` (`api-response.ts:28-37`), which ignores `Content-Type` — a cross-site `<form enctype="text/plain">` delivers an attacker-crafted JSON body with no CORS preflight (the exact technique `session-csrf.ts:11-14`'s own doc comment describes). For login/tech-login this is login-CSRF: the victim's browser is silently handed a session for an account the attacker controls (`Set-Cookie` is honored regardless of the request's cross-site origin). For invite-accept, an attacker holding their own valid token can force the same outcome. |
| Gauth-2: Password reset does not revoke existing sessions | P1 | `session-revocation.ts:22-24`, verified code comment: "does not yet revoke on password reset (the old token stays valid while the user is active with the same role) — that needs a per-user token version embedded at login and bumped on reset. Tracked as a follow-up." A stale/leaked token — for a user whose password an admin just reset via the very recovery path this page points people to — keeps authorizing for up to 24h. |
| Gauth-3: `page-auth` skill omits two of five auth surfaces | P2 | `.claude/skills/page-auth/SKILL.md:13-26` cites nothing under `src/app/signup/`, `src/app/api/auth/signup/`, `src/lib/auth/signup.ts`, `src/lib/auth/signup-intent.ts`, `src/app/tech-login/`, `src/app/api/auth/tech/`, `src/lib/auth/tech-session.ts`, `src/lib/auth/tech-config.ts` — all live routes (confirmed via `find`). AGENTS.md requires the skill updated alongside flow changes; already stale independent of this spec. |
| Gauth-4: Auth rate limiting is per-lambda-instance, not shared | P2 | `rate-limit.ts:1-79` — `slidingWindow` is backed by a module-level `Map` (`:5`); each concurrently warm serverless instance gets its own 5-req/min budget. Repo-wide pattern (every rate-limited route shares it), recorded rather than treated as new work. |
| Gauth-5: The Google "G" glyph SVG is duplicated verbatim in 4 files | P2 | Identical ~20-line `GoogleGlyph()` in `login-form.tsx:218-239`, `forgot-password-form.tsx:175-196`, `tech-login-form.tsx:128-149`, `signup-form.tsx:118-139` — any icon tweak needs 4 synchronized edits. |

Nothing rises to P0: Google verification, invite single-use/expiry/hash,
role-escalation guards, non-enumerating error copy, and tenant scoping all
hold up against their own code. This spec does not invent work to pad the
list.

## 5. Requirements

Only Gauth-1 and Gauth-2 clear the P0/P1 bar.

- **Rauth-1**: `/api/auth/login`, `/api/auth/tech/login`, and
  `/api/auth/invite/accept` must reject a request whose `Origin` is absent
  or doesn't match the app's own origin, before any DB read, bcrypt
  compare, or session mint — reusing the existing `isSameOriginRequest`
  guard (`session-csrf.ts:63-78`), so the accepted-caller set (same-origin
  `fetch`) is unchanged.
  **Acceptance criterion**: a route-level test posting to each route with
  `Origin: https://evil.example` gets a 403, no cookie set, no DB call
  made; a same-origin (or `NEXT_PUBLIC_APP_URL`-matching) request still
  succeeds exactly as today. Existing `route.test.ts` suites for these
  routes keep passing (add an `Origin` header to their simulated requests
  as needed).
- **Rauth-2**: A password reset must invalidate every session token issued
  to that user before the reset, within the existing revocation-freshness
  window — extending `isSessionUserCurrent` (`session-revocation.ts:41-71`,
  already one indexed per-request DB read) to also compare a stored
  per-user marker (e.g. a `tokenVersion` int or `passwordChangedAt`
  embedded in the JWT at sign time and bumped in the same statement that
  updates `passwordHash`) rather than adding a second round-trip.
  **Acceptance criterion**: a vitest test mints a token, resets the
  password (bumping the marker), and asserts the pre-reset token is now
  rejected while a freshly-minted post-reset token is accepted — mirroring
  the existing deactivation/demotion tests in `session-revocation.test.ts`.
  Fail-open-on-DB-error and the 30s positive cache (`:17-32`) are
  unchanged.

## 6. Non-goals

- Self-serve email password reset — deliberate (Brainstorm); the
  admin-reset model plus honest forgot-password copy is the design, not a
  gap.
- CAPTCHA/bot-challenges on any login form — no evidence of abuse; YAGNI.
- A distributed/shared rate-limit store (Gauth-4) — P2, repo-wide, out of
  scope for a single-page spec.
- Consolidating the duplicated `GoogleGlyph` component (Gauth-5) — P2
  polish, deferred per METHOD.md's severity gate.
- Changing the Google-only default login policy, the `?password=1`
  break-glass, or the invite/signup owner-promotion special case — all
  verified working as designed.
- `src/lib/ai` prompts / `output-guardrail.ts` — unrelated; listed in
  Invariants only as a repo-wide FROZEN surface to not brush against.
- Rauth-2's exact storage mechanism (new column vs. reusing a timestamp) is
  a plan-phase decision, not specified beyond "cheap, one DB read, compared
  inside the existing revocation check."

## 7. Invariants

- `resolveLoginMode` must keep returning `"password"` whenever Google isn't
  configured or `?password=1` is present — the only lockout-proof path.
- Forgot-password must never claim to send a reset email and must respond
  identically regardless of input — no account enumeration.
- Invite-accept must keep showing ONE generic message regardless of why the
  token is invalid — enumeration-proof.
- Login/tech-login/invite-accept must keep comparing against `DUMMY_HASH`
  on every ineligible case (timing-safe non-enumeration).
- Admin and technician session cookies must never alias — distinct names,
  and the tech JWT's `aud: "hvac-tech"` claim must stay required/rejected
  by the opposite verifier.
- An invite can only ever grant `admin`/`technician`; `super_admin` is
  reachable only via the owner-promotion special case, never
  `createInvite`/`canAssignRole` directly.
- `isPlatformAdmin` stays fail-closed unless both `PLATFORM_ADMIN_EMAILS`
  and `PLATFORM_ORG_ID` are set and the session's own org matches.
- `acceptInvite` keeps its create-user-then-claim ordering (no
  `db.transaction()` — neon-http throws) so the per-org unique email index
  stays the concurrency arbiter.
- The homepage demo-login link must keep `?password=1` or the demo creds
  dead-end (`src/app/page.tsx:230`).
- Copy canon: "sign in" not "login" on every CTA.
- Google id_token claims are never trusted before signature/issuer/
  audience/nonce verification against Google's own JWKS.
- Rauth-1/Rauth-2 must not touch `google-oidc.ts`, `google-login.ts`,
  `signup.ts`, or `invites.ts`'s role/owner-promotion logic — additive
  guards at the route/session layer, not authorization-policy changes.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint` on every changed file → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Existing auth regression pack (must stay green):
  `npx vitest run src/lib/auth/login-mode.test.ts src/lib/auth/google-oidc.test.ts src/lib/auth/google-login.test.ts src/lib/auth/authz.test.ts src/lib/auth/config.test.ts src/lib/auth/session-revocation.test.ts src/lib/admin/invites.test.ts src/app/api/auth/invite/accept/route.test.ts src/app/api/auth/tech/login/route.test.ts src/app/api/auth/tech/logout/route.test.ts`
- New pure/route-level tests (no jsdom/RTL) for Rauth-1 (cross-origin 403
  on all three routes) and Rauth-2 (pre-reset token rejected, post-reset
  accepted).
- `node scripts/agent/verify-skills.mjs` → 0 missing, after updating
  `page-auth/SKILL.md` to cite the signup and tech-login files (Gauth-3
  companion fix, done alongside the code change per AGENTS.md).
- Manual: `npm run dev` (background) →
  `node scripts/agent/screenshot-page.mjs` for `/admin/login`,
  `/admin/forgot-password`, `/signup`, `/tech-login` (all public) and
  confirm no visual regression; confirm the homepage demo-login link still
  lands on the password form.
