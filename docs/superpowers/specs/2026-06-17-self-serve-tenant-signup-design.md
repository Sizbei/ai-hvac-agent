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
2. **`POST /api/auth/signup/start`** — IP rate-limited; validates the business name; mints OIDC `state` + `nonce` (reuse `google-oidc-state`); sets a **signed, short-lived, httpOnly cookie** carrying `{ intent: "signup", businessName }`; redirects to Google consent with `redirect_uri` = the signup callback.
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
| `src/lib/auth/signup.ts` | `provisionOrgWithOwner(businessName, identity)` + the new-vs-existing decision (the brains; unit-tested, no HTTP). |
| `src/lib/admin/provisioning.ts` (refactor) | Extract `createOrgCore()` shared by invite-based (Stage 9) + signup provisioning. |
| `src/components/admin/onboarding/onboarding-checklist.tsx` + `getOnboardingState(orgId)` | Dismissible dashboard checklist; completion derived from live data. |

## Provisioning & data model
- **Refactor `provisioning.ts`** to extract `createOrgCore({ name, createdBy, ownerEmail, ownerUser? })`:
  it assembles the org + `organizationSettings` insert statements (org `status: "active"`, `plan: null`, `createdBy`, `ownerEmail`, slug with **auto-suffix on collision**) AND, when `ownerUser` is provided, the owner `users` insert — then runs **all of them in one `db.batch`** (atomic on neon-http). After the batch it seeds comms templates (best-effort, try/catch — a seed failure must not abort, per the Stage-9 fix). Returns `{ organizationId, ownerUserId? }`.
  - Stage 9's existing `provisionOrganization` calls `createOrgCore` **without** `ownerUser`, then creates the **owner invite** (unchanged behavior).
  - Signup's `provisionOrgWithOwner` calls `createOrgCore` **with** `ownerUser` = `{ role: "super_admin", googleId: identity.sub` (bound at creation = account-takeover guard)`, email, name, isActive: true }`, so org + settings + owner land in the single atomic batch. No invite (the owner is live-authenticated). Returns org + ownerUserId so the callback can mint a session.
- **Cap + collision:** reuse `PLATFORM_MAX_ORGS` (count check before create → `org_limit_reached`); slug derived from business name with a numeric/short-random suffix on uniqueness conflict so signup never hard-fails on a name clash.
- **Migration:** add `onboardingState jsonb` (nullable) to `organizationSettings`. Stores only non-derivable flags: `{ dismissed?: boolean, embedViewed?: boolean }`. All other steps derive from live data. Additive; generate `db:generate -- --name onboarding_state`; apply to prod before deploy (callback/onboarding read it).

## Onboarding checklist
- `getOnboardingState(orgId)` returns the six steps with completion **derived from live data** where possible:
  1. **Account created** — always ✓ (the org exists).
  2. **Business details** — org name set / a settings field filled.
  3. **Pricebook** — ≥1 active pricebook item.
  4. **Service hours** — after-hours/hours config set.
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
| Existing user email | Redirect `/admin/login?notice=existing_account`. |
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
- **Register the signup callback `redirect_uri`** (`<NEXT_PUBLIC_APP_URL>/api/auth/signup/callback`) in the **Google Cloud OAuth console**, and ensure `NEXT_PUBLIC_APP_URL` is correct in Vercel — the live OAuth round-trip fails without this.
- Apply migration `onboarding_state` to prod before deploy (per the migrations-not-run-on-deploy runbook).
- v1 ships free-tier only; paid upgrade is Stage 10 + the real Stripe adapter (separate spec).
