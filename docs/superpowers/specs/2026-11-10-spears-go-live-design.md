# Spears go-live: clean real account, platform switches, view-as — design v6 (FINAL)

Date: 2026-11-10 · Status: v6 FINAL — 4 adversarial rounds (13 critic runs);
round-4 findings applied; converged (remaining findings were localized). Speed lives in `2026-11-10-speed-design.md`.

## Why
Production's only tenant, `DEMO_ORG_ID` (`00000000-…-0001`, named "Demo HVAC
Company"), is Spears Services' live account: Chick's 6 active technicians, the
Twilio line, SMS, hosted chat and FieldPulse history (2,730 customers, ~$320k
open AR). It also carries seeded fake data, a demo name, demo-only behaviour,
and a public demo login (`admin@demo-hvac.com / admin123`, printed on the
landing page) that was an active admin. The client finds it slow and demo-like.

**User decisions (2026-11-10):** clean the existing org in place (no new org);
Chick's account should start empty; keep the FieldPulse data, visible to rchen;
rchen is platform owner with on/off switches, maps off for all; Chick onboards
by email; rchen can "view as Chick" including the setup guide and tutorial.

## Goals
1. No demo credential, or account created through it, can reach the org.
2. The org reads as "Spears Services"; nothing demo-like is shown to Chick.
3. **Chick starts clean.** Pre-go-live *history* is hidden from org users and
   visible to the platform owner; live work (open requests, upcoming visits,
   money still owed) and everything created after go-live stays visible —
   hiding collectible AR while dunning keeps texting those customers would harm
   the business. A stricter "empty" mode exists; the owner picks at go-live
   from dry-run counts (see P6).
4. Chick becomes `super_admin` via an emailed invite (copy-link fallback).
5. rchen is platform owner; platform switches (maps off) cannot be changed or
   bypassed by any org user, including a `super_admin`.
6. "View as Chick": a read-only, faithful preview for the platform owner,
   including the setup guide/checklist. "Tutorial" = the setup guide's guided
   steps (admin side has no separate tutorial) plus the technician guide
   `/tech/guide` (separate `hvac_tech_session`; previewing it is a stretch item).
7. Every admin page walked as Chick; nothing broken or demo-like remains.
8. Dev hydration warning from a browser extension silenced.

## Non-goals
New org or data moves; deleting any data (the fake-data purge is **dropped**:
pre-launch rows are hidden instead, and the purge had unsafe cascades); changing
FieldPulse/HCP sync; per-org Twilio routing; public demo replacement; session
revocation changes.

## Anti-goals
- Any row deleted. Any real technician or Chick losing access mid-day.
- An org user (any role) changing a platform switch or gaining platform powers.
- A customer texted or charged as a side effect of deploy.
- Prod changed during the client's working day.

## Established facts (verified across 2 rounds)
- Prod staff: rchen `super_admin` active; Chick (`chick.s@spearsservices.com`)
  `admin` **inactive**; 6 real technicians active; demo admin `admin` active;
  3 `@demo-hvac.com` technicians inactive.
- JWT sessions, no sessions table; `isSessionUserCurrent`
  (`session-revocation.ts:53`) reads `is_active`, `role` with a 30 s pass cache.
  Login paths: admin password (`auth/login/route.ts:79-93`), tech password
  (`auth/tech/login/route.ts:81`), Google (`google-login.ts:44,56` links by
  email when `google_id` is NULL), invite accept (`invites.ts`).
- A `super_admin` can reset any same-org user's password
  (`staff-queries.ts:resetStaffPassword`, `reset-password/route.ts:53`).
  `canAssignRole` never grants `super_admin`. There is **no** password-reset
  token flow (`forgot-password-form.tsx`: "We don't email reset links").
  Invites are hashed, single-use, 72 h, copy-link only; credential setup for an
  existing user requires no password + active + matching role
  (`invites.ts:119-136`); an invite cannot carry `super_admin`.
- `isPlatformAdmin` = `PLATFORM_ADMIN_EMAILS` + `PLATFORM_ORG_ID` + session in
  that org (`authz.ts:45-63`). With `PLATFORM_ORG_ID = DEMO_ORG_ID`, rchen shares
  the org with Chick.
- `DEMO_ORG_ID` special cases: review-request SMS off
  (`communication/consent.ts:158`), pay links blocked
  (`money-triggers.ts:420`), setup-guide pin (`layout.tsx:86`,
  `onboarding/route.ts:34,98`, `onboarding-queries.ts:54`), tech-sign-in stamp
  skipped (`tech-session.ts:40`), env-key fallback (`env-fallback.ts:2,14`,
  unchanged). Intake resolves to it (`voice/incoming:61`, `sms/incoming:74`,
  `webhooks/housecall:52`, `tenancy/organization.ts:71`), unchanged.
- Review-request jobs queued since the last daily drain would send on the
  first drain after the block lifts (`job-queue.ts:120-135`).
- Onboarding state is per org (`onboardingSelectSql(organizationId)`); a GET
  can write (grandfathering, `onboarding-steps.ts:203-221`,
  `onboarding-queries.ts:87`); write-once `firstSeenAt` gates grandfathering.
- No reliable "imported" origin marker exists for most tables; the import
  backdates `created_at` (`import/jobs.ts:513`) and merges into native
  customers (`import/customers.ts:375`). New intake reuses any matching
  customer (`upsertCustomerByContact`, `crm-queries.ts:1016-1020`).
- Read surfaces: ~30 modules / ~150 reads of requests/customers/invoices/
  estimates (`admin/queries.ts`, `crm-queries.ts`, `invoice-queries.ts`,
  `reporting-queries.ts`, `scheduling-queries.ts`, `estimate-queries.ts`,
  search, ops/insights, operations-metrics) plus inline SQL in a few routes.
- `getAdminSession()` (`session.ts:31`) cannot see the HTTP method; the proxy
  (`src/proxy.ts`, matcher includes `/api/:path*`) can. Some GET handlers write
  (Google callback, `connect`, exports' audit rows); some writes live outside
  `/api/admin` (`/api/communications/send`, `/api/platform/*`).
- `organizations` is only updated at targeted sites (`invites.ts:456`,
  `webhook-sync.ts:225`); migration 0059 is the next free number; tenant export
  lists columns explicitly (`export-queries.ts:77-82`).

## Design

### P0 — Lock down
- **Owner, now:** deactivate `admin@demo-hvac.com` in Staff.
- **Code — one shared refusal** `isRetiredDemoEmail(email)` (`@demo-hvac.com`),
  checked in admin password login, tech login, Google login (before linking),
  invite accept, and `isSessionUserCurrent` (which now also selects `email`
  from the DB, refuses retired emails, and refuses when the DB email differs
  from the token's — killing live JWTs ≤30 s).
  Constant-time dummy compare on password paths.
- **Code — remove the credentials** from `src/app/page.tsx`, `public/docs.html`,
  README/DEMO/GUIDE/DEPLOY, `.claude/skills/admin-pages` + `verify-page`,
  `scripts/screenshots.mjs`; `prod-smoke.sh` asserts the demo login is refused
  (401) and replaces its two demo-cookie checks with unauthenticated 401 checks.
- **Runbook SQL (user runs on prod, after hours):**
  1. All `@demo-hvac.com` users in the org: `is_active=false,
     password_hash=NULL, google_id=NULL`.
  2. Revoke live invites (`accepted_at IS NULL AND revoked_at IS NULL`) whose
     `invited_by_user_id` is a demo user.
  3. List every `audit_log` row by a demo user with action in
     (`create_staff`, `update_staff`, `reset_staff_password`,
     `create_technician`, `update_technician`, `create_invite`) and the users
     they touched (plus users who accepted a demo-created invite). The owner
     reviews the list (real technicians may have been set up through the demo
     login); for each user not confirmed legitimate: `is_active=false,
     password_hash=NULL, google_id=NULL`. Widget keys have no creator column:
     list all active keys; revoke any the owner doesn't recognise.

### P1 — The org is Spears, and demo-only behaviour becomes switches
- Runbook SQL: `organizations.name = 'Spears Services'`. `seed.ts:38` → "Spears
  Services" for dev parity.
- Replace the `DEMO_ORG_ID` checks for **review-request SMS** and **pay links**
  with feature switches `reviewRequests` and `payLinks` (default `true` for all
  orgs; both `DEMO_ORG_ID` and `PAY_LINK_DEMO_ORG_ID` constants go).
  Migration 0059 sets `feature_flags = {"reviewRequests": false,
  "payLinks": false}` for `DEMO_ORG_ID` only, and `seed.ts` writes the same on a
  fresh DB, so behaviour is unchanged at deploy. The copies that go:
  `consent.ts:123,158` and `PAY_LINK_DEMO_ORG_ID` (`money-triggers.ts:37`); the
  shared `DEMO_ORG_ID` stays (intake routing, onboarding route). The owner turns them on later, deliberately.
- The setup-guide pin and tech-sign-in stamp move behind
  `isDemoOrg(orgId)` = env `DEMO_MODE_ORG_IDS` (comma list, default empty);
  dev sets it to keep today's dev behaviour; prod leaves it empty.

### P2 — Chick onboards as `super_admin` by email
- Use the existing owner-promotion path (`invites.ts:425-460`), **tightened**:
  promotion to `super_admin` happens only when the invite email matches
  `organizations.owner_email` AND `invite.role = 'admin'` AND the inviter
  (`invited_by_user_id`) is a platform admin. Today it checks the email only,
  so any admin could invite the owner address as a technician and accept it.
  `canAssignRole` unchanged.
- Runbook SQL, one batch: assert Chick's user row exists in the org and
  `owner_email` is NULL or Chick's (stop otherwise); set Chick's user
  `is_active=true, role='admin', password_hash=NULL`; then
  `owner_email = 'chick.s@spearsservices.com'` (credential setup requires
  active + matching role + no password, `invites.ts:119-136`).
- New platform action **"Send owner invite"** on an org (also the re-send path):
  platform admin only; issues an `admin` invite to `owner_email` through
  `createInvite`, emails it.
- Email delivery for invites (platform action and Staff page): existing Resend
  `sendEmail` in `after()`; link from `NEXT_PUBLIC_APP_URL` (never request
  origin); no click tracking; per-org daily cap; escaped org name. Without
  `RESEND_API_KEY` the response says "not emailed" and returns the copy link
  (shown once, to platform admin / super_admin only).

### P3 — Platform owner, protected; feature switches
- Runbook env: `PLATFORM_ADMIN_EMAILS=rchen.workmail@gmail.com`,
  `PLATFORM_ORG_ID=DEMO_ORG_ID`.
- **Platform-admin users are protected:** a mutation targeting a user whose
  email is in `PLATFORM_ADMIN_EMAILS` — or creating/inviting a user with such an
  email, or changing any user's email to one — is refused unless the actor is a
  platform admin. There is no single mutation layer, so the guard
  `assertMayMutateUser(actor, target)` goes into each user-mutating function:
  `createStaff`, `updateStaff`, `resetStaffPassword`, `claimPasswordlessStaff`
  (`staff-queries.ts`), `createInvite` and owner promotion (`invites.ts`),
  technician create/update (`admin/queries.ts:1100,1146`). Each takes the full
  actor (`userId`, `email`, `role`, `organizationId`); the implicit
  `super_admin` role defaults (`staff-queries.ts:276,383`) are removed so an
  un-updated caller fails to compile. Google linking (`google-login.ts:58`)
  only links the matching email, already safe. On the invite-accept path
  (no session), the actor is the **inviter**, loaded from
  `invited_by_user_id`. Intentionally excluded (cannot reach an admin row:
  role-filtered or org-creating): FieldPulse/HCP technician sync, the FieldPulse
  import script, provisioning.
- Migration 0059: `organizations.feature_flags jsonb NOT NULL DEFAULT '{}'`
  (+ the Spears seed values above) + journal + snapshot; `drizzle-kit
  generate` → "No schema changes". Not included in tenant export (columns are
  explicit; flags are platform-owned).
- Keys and defaults: `map:false`, `reviewRequests:true`, `payLinks:true`,
  `showHistory:false`. `getFeatures(orgId)` (React `cache`), zod-parsed,
  unknown keys ignored; shares the `organizations` select already done by
  `loadBillingState` (`layout.tsx:61-77`) rather than adding a query.
- New `PATCH /api/platform/organizations/[id]`: platform gate, UUID check,
  rate limit, zod `{features: Partial<…>}`, `platform_audit_log`, refused
  while previewing.
- Map gates: nav item (`nav-items.ts:54`, ⌘K), `/admin/map` → `notFound()`,
  `api/admin/dispatch/map` and `api/admin/mapkit-token` → 404.
- Platform console: per-org switches.

### P6 — Clean start for Chick, history kept for rchen
- Migration 0059 adds `hidden_from_org boolean NOT NULL DEFAULT false` to
  `customers`, `service_requests`, `invoices`, `estimates`,
  `customer_sessions`. New rows default visible; every `onConflictDoUpdate`
  lists columns explicitly, so sync never resets the flag (verified).
- **Go-live marking script** `scripts/agent/golive-hide-history.mjs --org <id>
  [--mode history|empty]`, dry-run by default (per-table counts for BOTH
  modes, so the owner chooses), `--apply`, `--unhide`; idempotent; `db.batch()`;
  no deletes. "Today" uses `organization_settings.after_hours_config.timezone`,
  falling back to `BUSINESS_TIME_ZONE` (`calendar-time.ts:27`). The dry-run
  flags kept open requests older than 60 days (dev: 111 of 117) so the owner
  can decide on them.
  - `history` (default): hide everything EXCEPT requests whose status is not
    `completed`/`cancelled`; requests with any visit (`service_requests`
    schedule or non-cancelled `appointments.scheduled_date/starts_at`) from
    today onward; invoices with `state = 'open'` (not FieldPulse $0 drafts — dev
    has 474) plus native drafts; estimates still open; and, for every kept row,
    its customer, its request, and that request's session.
  - `empty`: hide everything except requests with a visit from today onward
    (and their customers/sessions). Open AR and unscheduled open requests are
    hidden — the dry-run output warns that dunning will keep reminding those
    customers.
- **Children follow their parent.** Reads of child tables that aggregate or
  list across parents (`payments` in `reporting-queries.ts:120`,
  `customer_equipment` in `warranty-queries.ts:73`, `messages` in
  `conversation-queries.ts`/`ai-insights-queries.ts`, notes, attachments,
  `communication_jobs`, `review_requests`, `appointments`) join to the parent's
  predicate. The plan enumerates every read; anything deliberately left
  unfiltered is listed.
- **Un-hide is enforced by the database, not by call sites.** A hand-authored
  plpgsql trigger (precedent: last-admin trigger, migration 0044) on INSERT of
  a visible row into `service_requests`, `invoices`, `estimates`,
  `customer_sessions`, and on UPDATE of `customer_id`/`service_request_id` on
  those tables, sets `hidden_from_org=false` on the referenced customer,
  request and session. This covers every insert site (tech-portal invoices,
  estimate→invoice, imports, voice sessions that attach a customer at insert,
  chat sessions that attach one later) without enumerating them. Upserts that
  only UPDATE other columns do not fire it. Integration test on the dev branch.
- The FieldPulse import itself runs from a script, not the page; the page only
  shows status. No gating needed for P6; setup-guide steps that point at it stay
  as they are.
- **Who sees hidden rows:** a platform admin not previewing, or any org user
  when `showHistory` is on. Others: excluded from lists, counts, search,
  dashboard/home, reports/insights/operations, calendar/dispatch, AR/money
  tiles; detail pages 404. Not a security boundary (`/api/admin/export` stays
  unfiltered).
- **Not filtered:** tech portal, conflict checks/availability, dispatch
  scoring, intake matching, crons (dunning, reconcile), sync, money writers.
- **Coverage test:** a structural vitest scans `src/lib/**` and
  `src/app/api/admin/**` for reads of the five flagged tables and the listed
  children that don't use `visibleRows`, against an explicit allowlist — so a
  missed read fails CI, not Chick.

### P7 — "View as" (platform owner, read-only)
- Start/exit are POSTs (Origin-checked) from `/admin/platform` or the header,
  platform admin only, target = an active user of the same org. Sets an
  HMAC-signed `hvac_preview` cookie (`SameSite=Strict`, HttpOnly, ≤2 h) bound to
  the platform admin's `userId` and the target `userId`; logout clears it.
- **Identity:** the real session stays authoritative (audit actor, rate limits
  and `isPlatformAdmin` stay rchen). The preview changes only rendering and
  visibility: the target's role for nav/role-gated UI, P6 rules as a non-platform
  viewer, P3 gates. Re-validated every request (target active, same org,
  cookie bound to this session); otherwise ignored.
- **Read-only at the proxy:** while the cookie is valid, `src/proxy.ts` refuses
  every request that is not GET/HEAD on every path it covers, except the
  preview-exit POST and `/api/auth/logout`; it also refuses an enumerated
  denylist of GET handlers that write (Google callback, integration `connect`,
  exports' audit writes). The app has no server actions. The cookie is signed
  with a key separate from the session key; the proxy clears a stale/invalid
  cookie so banner and behaviour never disagree.
- **Onboarding:** reads during preview never write (grandfathering, stamps,
  `firstSeenAt`). Runbook step after marking: reset
  `organization_settings.onboarding_state` — remove `dismissed`,
  `dismissedAt`, `completedSeenAt`, `firstCompleted`, `flags`, `embedViewed`; set
  `firstSeenAt = now()` so grandfathering never fires. Signals that read
  history (requests/appointments) count visible rows only. Expectation set
  honestly: steps genuinely done (technicians, phone, integrations, pricebook)
  show done; the guide shows Chick what's set up and what's left.
- Stretch: previewing a technician target renders `/tech/*` read-only.
- `platform_audit_log`: start/exit with ids only.
- Banner on every page: "Viewing as Chick Spears · read-only · Exit".

### P8 — Hand-over readiness pass
- Dev: set the dev default org to mirror prod (name, flags, run the marking
  script on dev, reset onboarding, a Chick-like `super_admin`). A reviewer
  subagent walks every admin page, the setup guide, the tutorial and the invite
  email as that user (via P7) at 1440 and 390 widths with
  `scripts/agent/screenshot-page.mjs`, and files defects: demo-like copy,
  confusing empty states, onboarding steps that don't fit, dead links, errors.
- One fix wave, re-walk; output `docs/spears-handover.md` (checklist + runbook).
- Speed is measured both as rchen and as Chick (preview), since list sizes differ.
- The runbook ends with a prod check: after deploy, rchen uses View as Chick on
  prod and walks the same pages.

### P5 — Hydration warning
`suppressHydrationWarning` on `<html>` in `src/app/layout.tsx:34` (CrossPilot
browser extension adds attributes). Verify no app-caused mismatch remains.

## Rollout (runbook in `docs/spears-handover.md`; all prod steps after hours,
user-run)
1. Owner deactivates demo admin (now). 2. Build on main; gates; reviews.
3. `vercel login`; deploy; `prod-smoke.sh`. 4. Env (P3) + `RESEND_API_KEY`
check; redeploy. 5. P0 SQL + rename. 6. Marking script dry-run (both modes) → owner picks mode → apply.
7. Onboarding reset (after marking; nobody opens the admin between deploy and here). 8. View as Chick on prod → walk. 9. Chick SQL + platform
invite email. Rollback: Vercel instant rollback; flags/`--unhide` reverse
everything; migration 0059 is additive.

## Build priority (cut line for the overnight run)
- **Must:** P0, P1, P3 (+ protection), P6 (+ coverage test), P2, P5.
- **Should:** P7 admin preview, P8 walk + fixes, speed S1 + S2.
- **Could:** P7 technician preview, speed S3/S4 (S3 runs after P6 — same files).

## Left to the builder
File layout, pure-helper vitest tests (no jsdom/RTL), copy within the
terminology canon, the exact read-only allowlist (enumerated in the plan).
