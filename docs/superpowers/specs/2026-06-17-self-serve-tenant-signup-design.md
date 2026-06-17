# Self-Serve Tenant Signup — Design Spec

**Date:** 2026-06-17 · **Status:** approved (brainstorm) → ready for implementation plan
**Plan refs:** PRODUCT-PLAN.md Stage 9 (provisioning) + Stage 10 (billing/entitlements)

## Goal & context
Today a new HVAC business can only be onboarded by a **platform admin** (Stage 9 `/admin/platform`). This spec adds **public self-serve signup**: a business visits `/signup`, authenticates with Google, and lands in their own provisioned org as super_admin — the keystone "real SaaS" funnel. This closes PRODUCT-PLAN's biggest multi-tenant gap (no org-creation path for end users).

**Decisions locked in brainstorm:**
- **Gating:** open + Google-verified, IP rate-limited + `PLATFORM_MAX_ORGS` cap (no access code).
- **Plan at signup:** free tier (Stage 10 default; paid upgrade via Stripe is later/out of scope).
- **Onboarding:** a guided, dismissible checklist on the dashboard.
- **Auth approach:** a **dedicated signup flow isolated from login** — `resolveGoogleLogin` and the login callback are NOT modified.

## Non-goals (v1)
- Paid-plan checkout at signup (free only; upgrade is Stage 10/Stripe, later).
- Email/password signup (Google-only, consistent with existing login).
- Custom per-org domains / white-label branding (separate follow-up).
- Trial-period billing semantics (org starts `status: active`, `plan: null` = free).

## Architecture & flow
Signup is parallel to, and isolated from, the existing login flow. The login policy
("Google authenticates, never auto-creates" — `resolveGoogleLogin`) is preserved unchanged.

1. **`/signup`** (public page, `src/app/signup/page.tsx`) — business-name input + "Sign up with Google" button (posts to start). Branded (BrandMark), reuses login-page styling.
2. **`POST /api/auth/signup/start`** — IP rate-limited (`RATE_LIMITS.sessionCreate`, matching login); validates the business name; mints OIDC `state` + `nonce` (reuse `google-oidc-state` cookie mechanism); sets a **distinct, signed (via existing `signToken`), short-lived (10min), httpOnly, sameSite:lax cookie `hvac_signup_intent`** carrying `{ businessName }`; redirects to Google consent built with a **signup-specific `redirectUri` override** = `<NEXT_PUBLIC_APP_URL>/api/auth/signup/callback`. Uses a new env `GOOGLE_OIDC_SIGNUP_REDIRECT_URI`; the route 404s when it's unset (mirrors `google/start`). The oidc helpers already take `config` by param — pass `{ ...loginConfig, redirectUri: signupRedirect }` rather than mutating shared config.
3. **`GET /api/auth/signup/callback`** — reuse `google-oidc` to verify the id_token (signature/iss/aud/exp/nonce) and require `email_verified === true`; validate `state` vs cookie; read + clear the signed businessName cookie; then branch:
   - **New email** (no `users` row for the normalized email): call `provisionOrgWithOwner({ businessName, identity })`, mint the admin session cookie (same mechanism the login callback uses), redirect to `/admin`.
   - **Existing email**: do NOT provision; redirect to `/admin/login` with a "you already have an account — sign in" notice.
   - **Org cap reached / unverified email / verify failure**: redirect to `/signup` with a friendly, typed error.

### Components (isolation — each one purpose, testable)
| Unit | Responsibility |
|---|---|
| `src/app/signup/page.tsx` | Public signup UI (name + Google button, error states). |
| `src/app/api/auth/signup/start/route.ts` | Rate-limit, validate name, set state/nonce + signed businessName cookie, redirect to Google. |
| `src/app/api/auth/signup/callback/route.ts` | Verify identity, branch new-vs-existing, provision + session or redirect. Thin; delegates to lib. |
| `src/lib/auth/signup.ts` | `provisionOrgWithOwner(businessName, identity)` + the new-vs-existing decision (the brains; unit-tested, no HTTP). **B2: the existing-email check is GLOBAL/cross-org — `db.select().from(users).where(eq(users.email, normalized)).limit(1)` (the `users` unique index is per-org, so no org filter + `limit(1)`); ANY hit → "existing account" → redirect to login, provision nothing. This covers the "email is already an admin of a DIFFERENT org" case — never create a 2nd org for them.** |
| `src/lib/admin/provisioning.ts` (refactor) | Extract `createOrgCore()` shared by invite-based (Stage 9) + signup provisioning. |
| `src/components/admin/onboarding/onboarding-checklist.tsx` + `getOnboardingState(orgId)` | Dismissible dashboard checklist; completion derived from live data. |

## Provisioning & data model
- **Refactor `provisioning.ts`** to extract `createOrgCore({ name, createdBy, ownerEmail, ownerUser? })`:
  it assembles the insert statements and runs them in **one `db.batch` ordered `[organizations, organizationSettings, users?]`** (org FIRST — both settings and users FK `organizations.id`). IDs (`org.id`, `users.id`) are generated client-side via `randomUUID()` so no mid-batch `.returning()` is needed and the callback gets `ownerUserId`. **Confirmed valid on neon-http** (batch = sequential statements in one implicit transaction; FK resolves because the org row exists by the time the users insert runs — same pattern as the already-shipped org+settings batch). After the batch it seeds comms templates (best-effort try/catch — a seed failure must not abort, per the Stage-9 fix). Returns `{ organizationId, ownerUserId? }`.
  - Stage 9's `provisionOrganization` calls `createOrgCore` **without** `ownerUser` and **WITH `ownerEmail` set** (the deferred-promotion handle that `acceptInvite` consumes), then creates the **owner invite** (unchanged).
  - Signup's `provisionOrgWithOwner` calls `createOrgCore` **with** `ownerUser` = `{ role: "super_admin", googleId: identity.sub` (bound at creation = takeover guard)`, email, name, isActive: true }` and **`ownerEmail: null`** — **B1 (CRITICAL): the self-serve owner is created super_admin directly, so there is NO pending invite; leaving `ownerEmail` set would strand a live `acceptInvite` super_admin-promotion trigger + PII. Self-serve path keeps `ownerEmail` NULL.** Returns org + ownerUserId so the callback mints the session.
- **B3 (batch error mapping):** the `createOrgCore` batch try/catch must map BOTH `organizations_slug_unique` (→ auto-suffix retry) AND the **global** `users_google_id_unique` violation (→ terminal "this Google account already has an account", redirect `/admin/login?notice=existing_account`) — not an opaque 500. `users_org_email_unique` is per-org so it can't catch a global email clash; the email check below is the guard.
- **Cap is a SOFT ceiling:** the `count(organizations) >= PLATFORM_MAX_ORGS` check (reused from Stage 9) is racy under concurrency (small bounded overshoot) — don't claim exact enforcement.
- **Cap + collision:** reuse `PLATFORM_MAX_ORGS` (count check before create → `org_limit_reached`); slug derived from business name with a numeric/short-random suffix on uniqueness conflict so signup never hard-fails on a name clash.
- **Migration:** add `onboardingState jsonb` (nullable) to `organizationSettings`. Stores only non-derivable flags: `{ dismissed?: boolean, embedViewed?: boolean }`. All other steps derive from live data. Additive; generate `db:generate -- --name onboarding_state`; apply to prod before deploy (callback/onboarding read it).

## Onboarding checklist
- `getOnboardingState(orgId)` returns the six steps with completion **derived from live data** where possible:
  1. **Account created** — always ✓ (the org exists).
  2. **Business details** — a concrete non-auto field is set (org name is always set at create, so key this on `organizationSettings` businessInfo `phone` OR `companyName` being non-empty — pick one explicit predicate).
  3. **Pricebook** — ≥1 active `pricebook_items` row for the org.
  4. **Service hours** — the `businessHours` key in the `organizationSettings` jsonb bag is present + non-empty (explicit predicate, since it's free-form jsonb).
  5. **Embed the widget** — `onboardingState.embedViewed` (set when the embed snippet is opened/copied).
  6. **Invite your team** — ≥1 staff invite or ≥2 active users.
- `onboarding-checklist.tsx`: a dismissible card on `/admin` dashboard with a progress bar; hidden once `onboardingState.dismissed` or all steps complete. Reuses Stage-6 `EmptyState`/card primitives + brand tokens. A `PATCH`/small route persists `dismissed`/`embedViewed`.

## Security
- `email_verified === true` strictly required (Google).
- super_admin is minted **only for a brand-new email with no existing user** — signup can never escalate an existing user; `googleId` is bound at creation.
- businessName is carried in a **signed, short-lived, httpOnly** cookie (never trusted raw across the OAuth round-trip); the OIDC `state` cookie provides CSRF; `nonce` provides id_token replay protection (reuse existing mechanisms).
- IP rate-limit on `/api/auth/signup/start`; `PLATFORM_MAX_ORGS` hard cap (independent of the in-memory rate limiter).
- Login flow + `resolveGoogleLogin` ("pre-provisioned only") are **unmodified** — no new auto-create path leaks into login.
- "You already have an account" is acceptable signup UX (not sensitive account enumeration like password reset).
- No PII in audit/logs: `org_provisioned` audit carries ids/enums only (no ownerEmail/name).

## Error handling
| Case | Behavior |
|---|---|
| Email not verified / id_token verify fails | Redirect `/signup?error=verification` (friendly). |
| Existing user email (any org — incl. admin of a different org) | Global lookup → redirect `/admin/login?notice=existing_account`; provision nothing. |
| Google `sub` already bound to another user (new email, reused sub) | Batch hits global `users_google_id_unique` → caught → `/admin/login?notice=existing_account`. |
| `PLATFORM_MAX_ORGS` reached | Redirect `/signup?error=signups_paused`. |
| Slug collision | Auto-suffix; never surfaced as an error. |
| Provisioning DB failure | org+settings+owner are one `db.batch` (all-or-nothing); on failure → `/signup?error=try_again`, no partial org. |
| Rate-limited | `429` from start route / friendly retry. |

## Testing
- **Unit (`src/lib/auth/signup.test.ts`, `provisioning.test.ts`):** `provisionOrgWithOwner` creates org + settings + a super_admin owner with `googleId` bound, free plan; slug auto-suffix on collision; `PLATFORM_MAX_ORGS` enforced; existing-email path provisions nothing. `createOrgCore` shared-refactor keeps Stage-9 invite provisioning green.
- **Callback logic:** new email → provision + session; existing email → redirect, no provision; `email_verified` false → reject; cap reached → paused.
- **Onboarding:** `getOnboardingState` derives each step correctly (pricebook count, hours, staff) and respects `dismissed`/`embedViewed`.
- Gates: `npm run test:unit`, `npm run eval` (unaffected), `npm run build`, `tsc` all green.

## Rollout / required external setup (user action)
- **Register the signup callback `redirect_uri`** (`<NEXT_PUBLIC_APP_URL>/api/auth/signup/callback`) in the **Google Cloud OAuth console**, set the new env **`GOOGLE_OIDC_SIGNUP_REDIRECT_URI`** to that URL in Vercel, and ensure `NEXT_PUBLIC_APP_URL` is correct — the signup routes 404 until the env is set and the live OAuth round-trip fails without the console registration.
- Apply migration `onboarding_state` to prod before deploy (per the migrations-not-run-on-deploy runbook).
- v1 ships free-tier only; paid upgrade is Stage 10 + the real Stripe adapter (separate spec).
