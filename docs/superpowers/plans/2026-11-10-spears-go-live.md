# Spears go-live (clean account, switches, view-as) + admin speed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan v2** — revised after adversarial round 1. See "Review log" at the end.

**Prerequisite:** main at `a4d5529` or later; `drizzle/0059` free (journal ends at idx 58 `0058_m3d_forms`, snapshot id `cce0c43f-8274-4a4d-8de5-b458fd99f27b`). Capture the vitest baseline before Task 1 (`npx vitest run 2>&1 | tail -5`) and report files / passed / skipped in every task report.

**Goal:** Production's only org becomes a clean "Spears Services" account:
- the demo login is dead;
- demo behaviour becomes platform switches that only rchen controls;
- pre-go-live history is hidden from org users but stays visible to the platform owner;
- Chick onboards as `super_admin` by email;
- rchen can "view as Chick" read-only;
- every admin route shows a frame instantly.

**Architecture:**
- **Migration.** One hand-authored migration (0059) adds `organizations.feature_flags`, adds `hidden_from_org` on five tables, and adds a plpgsql un-hide trigger. The trigger fires on visible inserts into the four child tables, on new messages and on new appointments.
- **Visibility.** A pure `visibility.ts` builds the hidden-row predicate from a `Visibility` value. Every swept read takes that value as a required parameter, so tsc finds every caller. A structural vitest checks each table read keeps doing this.
- **View as.** An HMAC cookie that the proxy enforces as read-only. `getViewerContext()` turns session + cookie + flags into the one value pages and routes pass down.
- **Prod data.** Every prod data change is in a user-run runbook (`docs/spears-handover.md`); agents never run it.

**Tech Stack:** Next.js 16 App Router (`src/proxy.ts` replaces middleware; `params` are Promises; `after()` from `next/server`), Drizzle 0.45 on neon-http (`db.batch()`; `db.transaction()` throws), zod 4, React `cache`, Web Crypto (HMAC in proxy), Resend (`sendEmail`, `src/lib/communication/resend-adapter.ts:48`), vitest node-only (+ `PgDialect().sqlToQuery` renders), Playwright (scripts only).

**Spec:** `docs/superpowers/specs/2026-11-10-spears-go-live-design.md` (v6 FINAL) and `docs/superpowers/specs/2026-11-10-speed-design.md` (v3). The specs are the authority; this plan argues from them.

**Rulings on spec ambiguities and deviations** (binding; Task 22 repeats them in the handover doc):

1. **Onboarding route.** `onboarding/route.ts:34,98` *are* the setup-guide pin, so they move to `isDemoOrg`. The `DEMO_ORG_ID` constant stays exported for intake (`voice/incoming:61`, `sms/incoming:74`, `webhooks/housecall:52`, `organization.ts:71`).
2. **Onboarding signals are always visible-only**, whoever is looking. Onboarding state is per org and its stamps are written once.
3. **Preview signing key** = HMAC-SHA256(`AUTH_SECRET`, `"hvac_preview/v1"`). It is a derived key, separate from the session key, and needs no new env var.
4. **Invite email cap.** At most 20 invite emails per org per rolling 24 h. The count of `staff_invites` rows created in the last 24 h is read BEFORE the new invite is inserted; the invite is emailed only if that count is ≤ 19. So the 21st invite in 24 h is created but not emailed, and the response says so.
5. **Marking script safety.**
   - `--apply` refuses if the org already has hidden rows, unless `--reapply` is passed.
   - On host `ep-withered-hill`, `--apply` and `--unhide` also need `--prod`.
   - Agents never pass `--prod`.
6. **Invite accept actor = the inviter**, loaded from `invited_by_user_id` (any org). It must be active and admin-tier; otherwise the invite is `invalid`. Its CURRENT role is used for `canAssignRole`. So an admin invite created by a `super_admin` who has since been demoted to `admin` is `invalid`. Separately, owner promotion to `super_admin` requires that inviter to be a platform admin (spec P2; Task 7).
7. **prod-smoke.** Three checks use the demo cookie: erase, SMS, mapkit-token. All three become unauthenticated `401` checks, and a new check asserts the demo login itself is refused with `401`.
8. **Dev keeps `DEMO_MODE_ORG_IDS` unset** during the build, so the dev default org mirrors prod for P8.
9. **Stale preview — deviation from spec P7** ("otherwise ignored"). If the cookie is valid but its target is no longer an active user of the same org, read-only stays enforced and the banner reads "Viewing as a user who is no longer available · read-only · Exit". Following "ignored" literally would let the proxy refuse writes with no banner shown, which the spec forbids ("banner and behaviour never disagree").
10. **"Open AR" keep rule:** keep invoices where `state = 'open'`, or where `state = 'draft' AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL`. FieldPulse and HCP drafts are not kept.
11. **Sweep ownership is by file.** Sweep A owns every function in `src/lib/admin/queries.ts` (dashboard builders and `getCustomerBookings` included) and `buildNeedsActionCountQuery`, which the dashboard calls at `queries.ts:1487`.
12. **Left unfiltered** (permanent allowlist, with a reason each):
    - `listTimesheetEntries` — technician time, not customer history;
    - `getAccountingExport` — an export;
    - `getScheduledJobsForRange` — feeds availability via `scheduling-source.ts:85`;
    - `getCommsOutcomeSummary` — send-outcome counts over a recent window; operational, not customer history.
13. **Reason codes renamed** off "demo":
    - consent `demo_org_restricted` → `review_requests_off`;
    - pay link `demo_restricted` → `pay_links_off` (403 `PAY_LINKS_OFF`, "Pay links are turned off for this account.").
14. **Speed S1 "first row"** = the first moment `main` has an `h1` and no `[data-slot="skeleton"]`, the same for every page. "Frame" = the first `main h1` or skeleton.
15. **Task 22 (handover doc) runs whatever the cut line**, and documents only what shipped.
16. **Resumable conversations stay visible.**
    - Both marking modes keep sessions whose status is `chatting`, `extracting` or `confirmed`, and their customers. Web chat and SMS resume these (`chat/route.ts:359-401`, `sms/incoming/route.ts:110-120`).
    - A trigger on `messages` INSERT un-hides the message's session and that session's customer.
    - A trigger on `appointments` INSERT (`cancelled_at IS NULL`) un-hides its request, plus the request's customer and session, so a new visit on an old request shows.
    - **Accepted gap:** a hidden request whose status alone is changed back to open (no new appointment, no new child row) stays hidden until `--unhide` or `showHistory`. It is listed in the handover doc.

## Global Constraints

- **Gates before every commit:**
  - `npx tsc --noEmit` → 0;
  - `npx eslint <changed files>` → 0 errors;
  - `npx vitest run` never below the live baseline (a single failure on a full run: rerun once before calling it a regression);
  - no jsdom/RTL — pure helpers tested in node;
  - `node scripts/agent/verify-skills.mjs` → 0 missing when `.claude/skills` changes;
  - after Task 3: `npx drizzle-kit generate` → "No schema changes".
- **Execution is SEQUENTIAL by default.** Subagents share ONE checkout: one task at a time, each committed and reviewed before the next starts. The only exception is the explicitly listed pairs under "Execution order".
- **Pair rule (a pair runs two tasks at once).**
  - Each member's gate is `npx tsc --noEmit 2>&1 | grep -F -f <file listing its own Files>` → empty, plus `npx vitest run <its own test files>`.
  - Each member commits only its own paths.
  - After BOTH commit, the controller runs the full gates (tsc 0, eslint on the union, full vitest ≥ baseline) before the next task starts.
- **DEV only.** `.env.local` is the DEV Neon branch; NEVER point it at prod (`ep-withered-hill`). Every integration suite and script refuses that host, except the marking script with an explicit `--prod`, which only the user runs.
- **No agent touches prod data.** Every prod SQL statement lives only in `docs/spears-handover.md` for the user to run after hours. No row is ever deleted.
- **Integration suites.**
  - Run manually: `VITEST_INTEGRATION=1 npx vitest run tests/integration/<file>`.
  - Use throwaway orgs (`createOrgCore`) only, never `00000000-0000-0000-0000-000000000001`, and delete the org in `afterAll`.
  - Follow the pattern in `tests/integration/onboarding-state.test.ts`.
  - Register each one in `INTEGRATION_SUITES` (`vitest.config.ts`).
- **Comms queue guard** (admin-pages skill) before any dev probe or walk: `SELECT count(*) FROM communication_jobs WHERE status='pending' AND scheduled_for <= now() + interval '15 minutes'` must be 0. No request is created through `POST /api/admin/requests` (the dev org pushes to live FieldPulse).
- **Database writes.**
  - neon-http: one `db.batch()` per multi-statement write.
  - `after()` for background work.
  - Hand migration: `--> statement-breakpoint` separators, a `_journal.json` entry, and a snapshot copy.
- **Tenancy and logging.**
  - Every admin query stays scoped by session `organizationId`.
  - Audit details hold ids, enums, booleans and counts only.
  - Logs carry codes and ids; never emails or names.
  - Responses never carry `err.message`.
- **Copy canon.** request / technician / sign in / cancelled / Unicode `…` and `’` / sentence case / human errors ("Couldn’t save X. Please try again."). The UI never says "demo". User-facing strings in this plan are exact.
- **Route conventions.**
  - Route files export only HTTP methods (+ `dynamic`); helpers live in `src/lib`.
  - Envelopes: `@/lib/api-response`.
  - `isUuid`: `@/lib/validation/uuid`.
  - Rate limits: `slidingWindow` + `RATE_LIMITS.adminMutation|adminRead`.
  - Every new state-changing route checks `isSameOriginRequest` (`src/lib/session-csrf.ts:63`).
- **FROZEN:** `src/lib/ai` safety text and the `src/lib/ai/output-guardrail.ts` regexes are untouched.
- **Git.**
  - `git add` only the task's files by path; never `-A`, never `--amend`, never `git stash`.
  - Every commit message ends with:
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
    `Claude-Session: https://claude.ai/code/session_01GuWoF6ikzSiaJchz1TKVur`
- **Read before editing:**
  - `.claude/skills/admin-pages/SKILL.md`;
  - the matching `page-<slug>` skill for a page task;
  - `node_modules/next/dist/docs/` for `proxy`, `loading.tsx` and `cookies()` (Next 16).

## Review Focus

1. **A pre-go-live customer comes back.** A hidden customer calls or chats; intake reuses the row (`upsertCustomerByContact`), or an old chat/SMS session is resumed. The new request, the session and the customer must all show for Chick. Pinned in Task 3 by:
   - `visible request insert un-hides its customer and session`;
   - `a message into a hidden session un-hides the session and its customer`;
   - `invoice insert un-hides customer, request, request session`.
2. **An org `super_admin` tries to take over rchen.** Chick resets rchen's password, demotes him, changes a technician's email to his, or invites his email. Each is refused. Pinned in Task 5 by:
   - `resetStaffPassword refuses a platform-admin target for a non-platform actor`;
   - `updateStaff refuses a role change on a platform admin`;
   - `updateTechnician refuses an email change to a platform-admin email`;
   - `createInvite refuses a platform-admin email`.
3. **A DB blip while reading flags.** No review SMS and no pay link is sent on the default `true` values. Pinned in Task 4 by:
   - `blocks review_request when getFeatures throws`;
   - `sendInvoicePayLink returns pay_links_off when getFeatures throws`.
4. **"Today" at the edges.** A visit at 00:30 local today is kept; a visit at 23:30 local yesterday is hidden; the org's timezone wins over the default. Pinned by Task 9 integration `visit at 00:30 local today is kept; 23:30 yesterday is hidden`.
5. **A live demo JWT after the DB row changes.** The token stops working within 30 s if the DB email changed, or if the token's email is a retired address in a different case or with spaces. Pinned in Task 1 by:
   - `refuses when the DB email differs from the token email`;
   - `isRetiredDemoEmail(' Admin@Demo-HVAC.com ') is true`.

---

## File map

| task | tier | creates | modifies |
| --- | --- | --- | --- |
| 1 | Must | `src/lib/auth/retired-demo.ts` (+test) | `session-revocation.ts` (+test), `session.ts`, `tech-session.ts` (+test), `google-login.ts` (+test), `api/auth/login/route.ts` (+test), `api/auth/tech/login/route.ts` (+test), `src/lib/admin/invites.ts` (`acceptInvite` only, +test) |
| 2 | Must | `src/lib/auth/no-demo-credentials.test.ts` | `src/app/page.tsx`, `public/docs.html`, `README.md`, `DEMO.md`, `GUIDE.md`, `DEPLOY.md`, `.claude/skills/admin-pages/SKILL.md`, `.claude/skills/verify-page/SKILL.md`, `scripts/screenshots.mjs`, `scripts/agent/prod-smoke.sh`, `scripts/agent/mint-admin-session.mjs`, `scripts/agent/mint-tech-session.mjs`, `src/app/layout.tsx` (P5) |
| 3 | Must | `drizzle/0059_golive.sql`, `drizzle/meta/0059_snapshot.json`, `src/lib/db/migration-0059.test.ts`, `tests/integration/golive-unhide.test.ts` | `src/lib/db/schema.ts`, `drizzle/meta/_journal.json`, `src/lib/db/seed.ts`, `vitest.config.ts` |
| 4 | Must | `src/lib/tenancy/feature-flags.ts` (+test), `src/lib/tenancy/org-row.ts`, `src/lib/tenancy/features.ts`, `src/lib/tenancy/demo-mode.ts` (+test) | `communication/consent.ts` (+test), `communication/money-triggers.ts` (+test), `tech/invoice-errors.ts` (+test), `components/admin/conversations/conversation-reply-logic.ts` (+test), `app/admin/(dashboard)/layout.tsx`, `api/admin/onboarding/route.ts` (+test), `auth/tech-session.ts`, `tests/api/invoice-pay-link.test.ts` |
| 5 | Must | — | `auth/authz.ts` (+test), `admin/staff-queries.ts` (+test), `admin/invites.ts` (+test), `admin/queries.ts` (`createTechnician`, `updateTechnician`), `admin/types.ts` (technician result unions), routes `staff/route.ts`, `staff/[id]/route.ts`, `staff/[id]/reset-password/route.ts`, `invites/route.ts`, `technicians/route.ts`, `technicians/[id]/route.ts`, `auth/invite/accept/route.ts` (+ their tests) |
| 6 | Must | `src/lib/admin/platform-features.ts` (+test) | `api/platform/organizations/[id]/route.ts` (+test), `api/platform/organizations/route.ts`, `components/admin/nav-items.ts` (+test), `sidebar.tsx`, `global-search.tsx`, `dashboard-shell.tsx`, `app/admin/(dashboard)/layout.tsx`, `app/admin/(dashboard)/map/page.tsx`, `api/admin/dispatch/map/route.ts` (+test), `api/admin/mapkit-token/route.ts` (+test), `components/admin/platform/platform-console.tsx` |
| 7 | Must | `src/lib/admin/invite-email.ts` (+test), `api/platform/organizations/[id]/owner-invite/route.ts` (+test) | `admin/invites.ts` (+test), `api/admin/invites/route.ts` (+test), `components/admin/invite-dialog.tsx`, `platform-console.tsx`, `api/platform/organizations/route.ts` |
| 8 | Must | `src/lib/admin/visibility.ts` (+test), `src/lib/admin/visibility-scan.ts` (+test), `src/lib/admin/visibility-coverage.test.ts`, `src/lib/admin/visibility-coverage/{permanent,pending-requests,pending-customers,pending-money,pending-insights}.json`, `src/lib/auth/viewer.ts`, `tests/integration/visibility-fixture.ts` | `vitest.config.ts` |
| 9 | Must | `src/lib/admin/golive-marking-sql.ts` (+test), `scripts/agent/golive-hide-history.mjs`, `tests/integration/golive-marking.test.ts` | `vitest.config.ts` |
| 10 | Must | `tests/integration/visibility-requests.test.ts` | Sweep A (Task 10) |
| 11 | Must | `tests/integration/visibility-customers.test.ts` | Sweep B (Task 11) |
| 12 | Must | `tests/integration/visibility-money.test.ts` | Sweep C (Task 12) |
| 13 | Must | `tests/integration/visibility-insights.test.ts` | Sweep D (Task 13) |
| **cut line A — Must ends** | | | |
| 16 | Should | `scripts/agent/measure-latency.mjs`, `src/lib/admin/latency-stats.ts` (+test) | — |
| 14 | Should | `src/lib/auth/preview-cookie.ts` (+test), `src/lib/auth/preview-gate.ts` (+test), `src/lib/admin/preview-targets.ts`, `api/admin/preview/route.ts` (+test), `api/admin/preview/exit/route.ts` (+test) | `src/proxy.ts`, `api/auth/logout/route.ts` |
| 17 | Should | `app/admin/(dashboard)/loading.tsx`, `src/lib/admin/loading-coverage.test.ts` | — |
| 15 | Should | `src/components/admin/preview-banner.tsx`, `src/lib/admin/preview-banner-copy.ts` (+test), `src/lib/auth/viewer.test.ts`, `scripts/agent/mint-preview-cookie.mjs` | `auth/viewer.ts`, `app/admin/(dashboard)/layout.tsx`, `dashboard-shell.tsx`, `admin/onboarding-queries.ts`, `api/admin/onboarding/route.ts` (+test), `platform-console.tsx`, `scripts/agent/screenshot-page.mjs`, `scripts/agent/measure-latency.mjs` |
| 18 | Should | (walk fixes) | (walk fixes) |
| **cut line B — Should ends** | | | |
| 19 | Could | — | `auth/tech-session.ts` (+test), `tech/guide-queries.ts` (+test), `api/tech/guide/route.ts`, `src/proxy.ts`, `auth/preview-gate.ts` (+test) |
| 20 | Could | — | list queries and list endpoints (after 10–13) |
| 21 | Could | — | page clients with serial fetches |
| 22 | Always | `docs/spears-handover.md` | `.claude/skills/admin-pages/SKILL.md` |

## Execution order

All steps run sequentially. Each `∥` pair is fully disjoint in files AND in compile-time callers, and follows the pair rule.

1. **Task 1 ∥ Task 3.**
   - Task 1 changes `isSessionUserCurrent` (callers `session.ts` and `tech-session.ts` are in Task 1) and `acceptInvite`.
   - Task 3 adds columns only (no existing caller changes) plus migration files, `seed.ts` and `vitest.config.ts`.
2. **Task 2 ∥ Task 9.**
   - Task 2 touches docs, `.mjs`/`.sh` scripts, `page.tsx`, the root `layout.tsx`, and a new standalone test.
   - Task 9 adds only new files plus `vitest.config.ts` (Task 3 is committed by now).
3. **Task 4.**
4. **Task 5.**
5. **Task 6.**
6. **Task 7 ∥ Task 8.**
   - Task 7 touches `invites.ts`, the invites route, `invite-dialog`, platform routes and the console.
   - Task 8 adds only new modules plus `vitest.config.ts`.
   - Task 8 reads `getFeatures`, `isPlatformAdmin` and `getAdminSession`, which Task 7 does not change. Task 7 reads no table that Task 8's scanner flags.
7. **Task 10 → 11 → 12 → 13**, strictly in that order. Each sweep changes signatures whose callers span routes.
   - **— cut line A —**
8. **Task 16**, alone. It builds the baseline with `next build`, so nothing else may be editing.
9. **Task 14 ∥ Task 17.**
   - Task 14 touches the proxy, auth helpers and the preview routes.
   - Task 17 adds a new `loading.tsx` plus a test.
   - Task 17's after-measurement is deferred to the controller once both commit.
10. **Task 15**, then **Task 18** (controller).
    - **— cut line B —**
11. **Task 19 → 20 → 21.**
12. **Task 22.**

Task numbers stay as written in the specs' priority groups; this order is authoritative. `vitest.config.ts` is touched by 3, 8 and 9 (append-only). Re-read it before editing.

---

### Task 1: One refusal for retired demo emails (P0 code)

**Files:**
- Create: `src/lib/auth/retired-demo.ts`, `src/lib/auth/retired-demo.test.ts`
- Modify:
  - `src/lib/auth/session-revocation.ts:41-70`
  - `src/lib/auth/session.ts:44`
  - `src/lib/auth/tech-session.ts:71`
  - `src/lib/auth/google-login.ts:44`
  - `src/app/api/auth/login/route.ts:79-93`
  - `src/app/api/auth/tech/login/route.ts:81`
  - `src/lib/admin/invites.ts` (`acceptInvite:362`, right after `resolveInviteByToken`)
- Test:
  - `src/lib/auth/session-revocation.test.ts`
  - `src/lib/auth/google-login.test.ts`
  - `src/app/api/auth/login/route.test.ts`
  - `src/app/api/auth/tech/login/route.test.ts`
  - `src/lib/admin/invites.test.ts`
  - `src/lib/auth/tech-session.test.ts` (call shape)

**Interfaces:**
- Produces:
  - `isRetiredDemoEmail(email: string | null | undefined): boolean` — trims and lowercases, then is true when the email ends with `@demo-hvac.com`.
  - `isSessionUserCurrent(userId: string, organizationId: string, role: string, email: string): Promise<boolean>` — the cache key includes the email; a retired or mismatched email is denied and never cached.

- [ ] **Step 1: Write the failing tests**
```ts
// retired-demo.test.ts
expect(isRetiredDemoEmail("admin@demo-hvac.com")).toBe(true);
expect(isRetiredDemoEmail(" Admin@Demo-HVAC.com ")).toBe(true);
expect(isRetiredDemoEmail("mike.johnson@demo-hvac.com")).toBe(true);
expect(isRetiredDemoEmail("chick.s@spearsservices.com")).toBe(false);
expect(isRetiredDemoEmail("x@demo-hvac.com.evil.io")).toBe(false);
expect(isRetiredDemoEmail(null)).toBe(false);
// session-revocation.test.ts (mock users gains email)
it("refuses a retired demo email even when active with the right role")
it("refuses when the DB email differs from the token email")
it("accepts an email that differs only by case/whitespace")
it("does not cache a denial")
// google-login.test.ts
it("refuses a retired demo user before linking google_id")   // {ok:false, reason:"no_account"}; db.update not called
// admin + tech login route tests
it("returns 401 INVALID_CREDENTIALS for an active demo user with the right password and still runs bcrypt.compare once")
// invites.test.ts
it("acceptInvite returns invalid for an invite to a @demo-hvac.com email")   // createStaff not called
```
- [ ] **Step 2: Run** `npx vitest run src/lib/auth src/app/api/auth src/lib/admin/invites.test.ts`. Expected: FAIL (`isRetiredDemoEmail` is not defined).
- [ ] **Step 3: Implement.**
  - `retired-demo.ts` is pure (no `server-only` import).
  - `isSessionUserCurrent` selects `users.email`. It passes only when the normalized `row.email` equals the normalized token email AND `!isRetiredDemoEmail(row.email)`. Both callers pass `payload.email`.
  - Both login routes fold `!isRetiredDemoEmail(user.email)` into `eligibleUser`, so the dummy-hash compare still runs.
  - `resolveGoogleLogin` returns `no_account` before the `google_id` link.
  - `acceptInvite` returns `invalid` before `createStaff`.
- [ ] **Step 4: Run** the same command → PASS. Then `npx tsc --noEmit` (pair rule: filter on own files).
- [ ] **Step 5: Commit** — `feat(golive): refuse retired demo emails at every sign-in and on live sessions`.

### Task 2: Remove the published demo credentials; fix the mint scripts; hydration warning (P0 docs, P5)

**Files:**
- Create: `src/lib/auth/no-demo-credentials.test.ts`
- Modify:
  - `src/app/page.tsx:219-235` — remove the "Staff demo login" paragraph.
  - `public/docs.html`, `README.md`, `DEMO.md`, `GUIDE.md`, `DEPLOY.md`.
  - `.claude/skills/admin-pages/SKILL.md:31` — "Prod visuals: View as (platform owner) — see docs/spears-handover.md".
  - `.claude/skills/verify-page/SKILL.md`, `scripts/screenshots.mjs`.
  - `scripts/agent/prod-smoke.sh:17-31`.
  - `scripts/agent/mint-admin-session.mjs:25-30`, `scripts/agent/mint-tech-session.mjs:27-32`.
  - `src/app/layout.tsx:34`.

**Interfaces:**
- Produces: `MINT_EMAIL=<email>`. When set, `mint-admin-session.mjs` picks that active admin-tier user. Without it, both mint scripts add `AND lower(email) NOT LIKE '%@demo-hvac.com'` and `ORDER BY created_at, id`, because Task 1 refuses demo sessions.

- [ ] **Step 1: Write the failing test.** `published files carry no demo credentials` reads each published file listed above (paths hard-coded) and expects no `admin123` and no `admin@demo-hvac.com`.
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/no-demo-credentials.test.ts` → FAIL.
- [ ] **Step 3: Edit.**
  - prod-smoke: the `COOKIE=` login block becomes `check "demo login refused" 401 <POST /api/auth/login with the demo body>`. The erase, SMS and mapkit-token checks drop the cookie and expect `401` (ruling 7).
  - Root layout: `<html lang="en" suppressHydrationWarning className=…>`.
  - Leave `seed.ts` alone; Task 3 owns it.
- [ ] **Step 4: Run.**
  - The test → PASS.
  - `bash -n scripts/agent/prod-smoke.sh` → exit 0.
  - `node scripts/agent/verify-skills.mjs` → 0 missing.
  - `MINT_EMAIL=<dev non-demo super_admin email> npx tsx scripts/agent/mint-admin-session.mjs` prints a token.
  - P5: `node scripts/agent/screenshot-page.mjs /admin 1440` (dev server running) shows no hydration overlay.
- [ ] **Step 5: Commit** — `chore(golive): remove published demo credentials; smoke asserts the demo login is refused; mint scripts skip demo users; silence extension hydration warning`.

### Task 3: Migration 0059 — feature flags, hidden_from_org, un-hide triggers

**Files:**
- Create: `drizzle/0059_golive.sql`, `drizzle/meta/0059_snapshot.json` (generated), `src/lib/db/migration-0059.test.ts`, `tests/integration/golive-unhide.test.ts`
- Modify:
  - `src/lib/db/schema.ts` — organizations `:227`, customerSessions `:413`, serviceRequests `:504`, customers `:825`, estimates `:2881`, invoices `:2975`.
  - `drizzle/meta/_journal.json`.
  - `src/lib/db/seed.ts:38` — name "Spears Services"; `featureFlags: { reviewRequests: false, payLinks: false }`.
  - `vitest.config.ts` — add `tests/integration/golive-unhide.test.ts`.

**Interfaces:**
- Produces:
  - `organizations.featureFlags: jsonb("feature_flags").$type<Record<string, unknown>>().notNull().default({})`.
  - `hiddenFromOrg: boolean("hidden_from_org").notNull().default(false)` on `customers`, `serviceRequests`, `invoices`, `estimates`, `customerSessions`.
  - DB function `unhide_parents()` and its triggers: `trg_unhide_parents` on the four child tables, `trg_unhide_from_message` on `messages`, `trg_unhide_from_appointment` on `appointments`.

- [ ] **Step 1: Write the failing pure test** `migration-0059.test.ts` (style of `src/lib/forms/migration-0058.test.ts`):
  - `adds feature_flags NOT NULL DEFAULT '{}' with IF NOT EXISTS`
  - `adds hidden_from_org to exactly customers, service_requests, invoices, estimates, customer_sessions`
  - `seeds reviewRequests:false and payLinks:false for 00000000-0000-0000-0000-000000000001 only, merging with ||`
  - `child triggers fire AFTER INSERT WHEN (NEW.hidden_from_org = false)`
  - `UPDATE triggers fire only when a parent column really changed`: on `service_requests` and `customer_sessions`, `WHEN (NEW.hidden_from_org = false AND OLD.customer_id IS DISTINCT FROM NEW.customer_id)`; on `invoices` and `estimates`, `WHEN (NEW.hidden_from_org = false AND (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.service_request_id IS DISTINCT FROM NEW.service_request_id))`. Reason: FieldPulse re-sync re-SETs these columns to the same values (`fieldpulse/invoice-sync.ts:495-518`, `import/estimates.ts:162`), and that must not un-hide history.
  - `messages and appointments get AFTER INSERT triggers (appointments WHEN cancelled_at IS NULL)`
  - `every statement is separated by --> statement-breakpoint; the function uses CREATE OR REPLACE and each trigger DROP TRIGGER IF EXISTS`
- [ ] **Step 2: Run** `npx vitest run src/lib/db/migration-0059.test.ts` → FAIL.
- [ ] **Step 3: Generate the snapshot.** Edit `schema.ts`, then run `npx drizzle-kit generate --name golive --dialect postgresql --schema src/lib/db/schema.ts --out .golive-drizzle/drizzle` against a scratch copy of `drizzle/`. Copy its `0059_snapshot.json` (`prevId` must be `cce0c43f-8274-4a4d-8de5-b458fd99f27b`) and append its journal entry (idx 59, tag `0059_golive`).
- [ ] **Step 4: Hand-write `0059_golive.sql`.**
  - `ADD COLUMN IF NOT EXISTS` with the generated names.
  - The seed `UPDATE … SET feature_flags = feature_flags || '{"reviewRequests":false,"payLinks":false}'::jsonb WHERE id = '00000000-0000-0000-0000-000000000001'`.
  - The trigger function. Each un-hide is `UPDATE <t> SET hidden_from_org = false WHERE id = X AND hidden_from_org`. Branch on `TG_TABLE_NAME`:
    - `service_requests` → its customer and its session.
    - `invoices` / `estimates` → their customer; their request; that request's session and customer.
    - `customer_sessions` → its customer.
    - `messages` → its session and that session's customer.
    - `appointments` → its request, and that request's customer and session.
- [ ] **Step 5: Clean up and check.** Remove `.golive-drizzle/`. Run the pure test → PASS. `npx drizzle-kit generate` → "No schema changes". `npm run db:migrate` on DEV → applied once.
- [ ] **Step 6: Write and run the integration suite** `golive-unhide.test.ts` (throwaway org; seeding as in `onboarding-state.test.ts` `seedRest`; rows marked hidden by direct UPDATE):
  - `visible request insert un-hides its customer and session`
  - `invoice insert un-hides customer, request, request session`
  - `estimate insert un-hides its request and customer`
  - `session customer_id update un-hides the customer`
  - `a message into a hidden session un-hides the session and its customer`
  - `an appointment on a hidden request un-hides the request, its customer and session; a cancelled one does not`
  - `inserting a row with hidden_from_org=true un-hides nothing`
  - `an upsert that updates only other columns leaves the flag` (`INSERT … ON CONFLICT (id) DO UPDATE SET description = …` on a hidden request → still hidden)
  - `an UPDATE that re-sets customer_id/service_request_id to the same values un-hides nothing`
  - `re-running upsertInvoiceRecord on a hidden FieldPulse invoice leaves the invoice, its customer and its request hidden` — call `upsertInvoiceRecord` (`src/lib/integrations/fieldpulse/invoice-sync.ts:373`) twice with the same mapped invoice; no network is needed because the function takes the already-fetched record.
  - `updating hidden_from_org itself does not cascade`
  - `re-executing every 0059 statement is a no-op` — read `drizzle/0059_golive.sql`, split it on `--> statement-breakpoint`, `db.execute(sql.raw(stmt))` each twice. No error, and the column defaults and the seed values are unchanged.

  Run `VITEST_INTEGRATION=1 npx vitest run tests/integration/golive-unhide.test.ts` → PASS.
- [ ] **Step 7: Commit** — `feat(golive): migration 0059 — feature flags, hidden_from_org, un-hide triggers`.

### Task 4: Feature flags and demo mode replace the DEMO_ORG_ID special cases (P1)

**Files:**
- Create: `src/lib/tenancy/feature-flags.ts` (+`.test.ts`), `src/lib/tenancy/org-row.ts`, `src/lib/tenancy/features.ts`, `src/lib/tenancy/demo-mode.ts` (+`.test.ts`)
- Modify:
  - `src/lib/communication/consent.ts:115-162`
  - `src/lib/communication/money-triggers.ts:34-37,381,420`
  - `src/lib/tech/invoice-errors.ts:8,31`
  - `src/components/admin/conversations/conversation-reply-logic.ts:50-57`
  - `src/app/admin/(dashboard)/layout.tsx:61-90`
  - `src/app/api/admin/onboarding/route.ts:34,98`
  - `src/lib/auth/tech-session.ts:40`
- Test:
  - `consent.test.ts`, `money-triggers.test.ts`, `invoice-errors.test.ts`
  - `conversation-reply-logic.test.ts`
  - `src/app/api/admin/onboarding/route.test.ts`
  - `tests/api/invoice-pay-link.test.ts`

**Interfaces:**
- Produces:
  - `type FeatureKey = "map" | "reviewRequests" | "payLinks" | "showHistory"`
  - `type Features = Readonly<Record<FeatureKey, boolean>>`
  - `DEFAULT_FEATURES: Features = { map:false, reviewRequests:true, payLinks:true, showHistory:false }`
  - `parseFeatures(raw: unknown): Features` — unknown keys and non-booleans are ignored.
  - `featurePatchSchema` — zod strict object of optional booleans per key, with at least one key.
  - `loadOrgRow = cache(async (organizationId: string) => ({ status, name, featureFlags } | null))`
  - `getFeatures(organizationId: string): Promise<Features>` — no `server-only`; THROWS on a DB error.
  - `isDemoOrg(organizationId: string, list = process.env.DEMO_MODE_ORG_IDS): boolean`
  - Reasons `"review_requests_off"` and `"pay_links_off"`.

- [ ] **Step 1: Write the failing tests**
```ts
expect(parseFeatures(null)).toEqual(DEFAULT_FEATURES);
expect(parseFeatures({ map: true, junk: 1, payLinks: "no" })).toEqual({ ...DEFAULT_FEATURES, map: true });
expect(featurePatchSchema.safeParse({}).success).toBe(false);
expect(featurePatchSchema.safeParse({ map: true, extra: true }).success).toBe(false);
expect(isDemoOrg("o1", "")).toBe(false);
expect(isDemoOrg("o1", " o0, o1 ")).toBe(true);
// consent.test.ts
it("blocks review_request when reviewRequests is off")    // {allowed:false, reason:"review_requests_off"}
it("allows review_request when reviewRequests is on, for DEMO_ORG_ID too")
it("blocks review_request when getFeatures throws")
it("never consults features for other triggers")
// money-triggers.test.ts
it("sendInvoicePayLink returns pay_links_off when payLinks is off")
it("sendInvoicePayLink returns pay_links_off when getFeatures throws")
it("PAY_LINK_DEMO_ORG_ID is no longer exported")
// invoice-errors.test.ts
expect(routeError("pay_links_off")).toMatchObject({ status: 403, code: "PAY_LINKS_OFF", message: "Pay links are turned off for this account." });
// conversation-reply-logic.test.ts
it("maps review_requests_off to 'Review requests are turned off for this account.' and has no demo copy")
// onboarding route.test.ts
it("passes demo:true only when DEMO_MODE_ORG_IDS lists the org")
```
- [ ] **Step 2: Run** `npx vitest run src/lib/tenancy src/lib/communication/consent.test.ts src/lib/communication/money-triggers.test.ts src/lib/tech/invoice-errors.test.ts src/components/admin/conversations/conversation-reply-logic.test.ts src/app/api/admin/onboarding tests/api/invoice-pay-link.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - consent: `DEMO_ORG_BLOCKED_TRIGGERS` becomes `FEATURE_GATED_TRIGGERS`. `getFeatures` runs in a try/catch that blocks on error, logging code and org id.
  - money-triggers: delete `PAY_LINK_DEMO_ORG_ID`. At the old `:420` call `getFeatures`; both "off" and an error give `pay_links_off`.
  - `layout.tsx`: `loadBillingState` reads `loadOrgRow` (the same single select, now also `feature_flags`); `loadSetupPlacement` uses `isDemoOrg`.
  - The onboarding route and `tech-session.ts:40` use `isDemoOrg`.
  - Remove the now-unused `DEMO_ORG_ID` imports in those three files only.
- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit` → 0. `grep -rnE "PAY_LINK_DEMO_ORG_ID|demo_restricted|demo_org_restricted" src --include='*.ts' --include='*.tsx' | grep -vE ':[0-9]+:\s*(//|\*)'` → no lines.
- [ ] **Step 5: Commit** — `feat(golive): review requests and pay links become feature switches; demo-only behaviour behind DEMO_MODE_ORG_IDS`.

### Task 5: Platform-admin users are protected (P3 protection)

**Files:**
- Modify:
  - `src/lib/auth/authz.ts`
  - `src/lib/admin/staff-queries.ts` — `createStaff:183`, `updateStaff:267`, `resetStaffPassword:372`, `claimPasswordlessStaff:430`; delete the `= "super_admin"` defaults at `:190,276,378`.
  - `src/lib/admin/invites.ts` — `createInvite:98`, `resolveInviteByToken:280`, `acceptInvite:362`.
  - `src/lib/admin/queries.ts` — `createTechnician:1093`, `updateTechnician:1126`.
  - `src/lib/admin/types.ts` — new result unions next to `CreateTechnicianInput:507`.
  - Routes: `src/app/api/admin/staff/route.ts:86`, `staff/[id]/route.ts:111`, `staff/[id]/reset-password/route.ts:53`, `invites/route.ts:67`, `technicians/route.ts:65`, `technicians/[id]/route.ts:57`, `src/app/api/auth/invite/accept/route.ts:76`.
- Test: `authz.test.ts`, `staff-queries.test.ts`, `invites.test.ts`, `staff/route.test.ts`, `staff/[id]/route.test.ts`, `invites/route.test.ts`, `auth/invite/accept/route.test.ts`, new `src/app/api/admin/technicians/route.test.ts` and `technicians/[id]/route.test.ts`

**Interfaces:**
- Consumes: Task 1's retired-email check in `acceptInvite` (kept).
- Produces (in `authz.ts`):
  - `interface MutationActor { readonly userId: string; readonly email: string; readonly role: AdminRole; readonly organizationId: string }` — `AdminSessionPayload` satisfies it.
  - `isPlatformAdminEmail(email: string | null | undefined): boolean` — `isPlatformAdmin` now calls it.
  - `assertMayMutateUser(actor: MutationActor, target: { readonly email?: string | null; readonly newEmail?: string | null }): { ok: true } | { ok: false; reason: "platform_protected" }`
- Produces (in `types.ts`):
  - `type CreateTechnicianResult = { ok: true; technician: TechnicianRecord } | { ok: false; reason: "forbidden" }`
  - `type UpdateTechnicianResult = { ok: true; technician: TechnicianRecord } | { ok: false; reason: "not_found" | "forbidden" }`
- New signatures (each takes `actor: MutationActor` in place of `actorRole`):
  - `createStaff(org, input, actor)`
  - `updateStaff(org, userId, input, actor)`
  - `resetStaffPassword(org, userId, newPassword, actor)`
  - `claimPasswordlessStaff(org, input, actor)`
  - `createInvite(org, input, actor)` — `invitedByUserId = actor.userId`
  - `createTechnician(org, input, actor): Promise<CreateTechnicianResult>`
  - `updateTechnician(org, id, input, actor): Promise<UpdateTechnicianResult>`
- Also produced:
  - `resolveInviteByToken`'s `invite` gains `invitedByUserId: string | null`.
  - `loadInviter(userId: string | null): Promise<MutationActor | null>` (`invites.ts`) — looks in any org; returns null unless the user is active and admin-tier.
- Route mapping:
  - `platform_protected` maps to the caller's existing `forbidden` reason → 403 `FORBIDDEN`.
  - Technician routes: `forbidden` → `errorResponse("Forbidden", "FORBIDDEN", 403)`; update `not_found` → the route's existing 404.

- [ ] **Step 1: Write the failing tests**
```ts
// authz.test.ts (PLATFORM_ADMIN_EMAILS="r@x.com", PLATFORM_ORG_ID=PORG)
expect(assertMayMutateUser(chick, { email: "r@x.com" })).toEqual({ ok:false, reason:"platform_protected" });
expect(assertMayMutateUser(chick, { email: "t@x.com", newEmail: " R@X.com" })).toEqual({ ok:false, reason:"platform_protected" });
expect(assertMayMutateUser(rchen, { email: "r@x.com" })).toEqual({ ok:true });
expect(assertMayMutateUser(chick, { email: "t@x.com" })).toEqual({ ok:true });
// env unset → isPlatformAdminEmail false → all ok:true
// staff-queries.test.ts
it("resetStaffPassword refuses a platform-admin target for a non-platform actor")    // forbidden; hash not called
it("updateStaff refuses a role change on a platform admin")                         // {role:"admin"} by a super_admin → forbidden
it("updateStaff refuses deactivating a platform admin for a non-platform actor")
it("createStaff refuses a platform-admin email for a non-platform actor")
it("claimPasswordlessStaff refuses a platform-admin email when the actor is not a platform admin")
// invites.test.ts
it("createInvite refuses a platform-admin email")
it("acceptInvite returns invalid when the inviter is inactive or no longer admin-tier")
it("acceptInvite returns invalid for an admin invite whose inviter was demoted from super_admin to admin")
// technicians route tests
it("POST 403 FORBIDDEN when the email is a platform-admin email")
it("PATCH 403 FORBIDDEN when changing an email to a platform-admin email")
it("PATCH 404 when the technician does not exist")
```
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/authz.test.ts src/lib/admin/staff-queries.test.ts src/lib/admin/invites.test.ts src/app/api/admin/staff src/app/api/admin/invites src/app/api/admin/technicians src/app/api/auth/invite` → FAIL.
- [ ] **Step 3: Implement.**
  - Each function calls `assertMayMutateUser` before any write. The target email comes from the loaded row; `newEmail` comes from the patch or input.
  - `updateTechnician` pre-reads the current email within its existing `role = 'technician'` scope.
  - `acceptInvite` loads the actor with `loadInviter(invite.invitedByUserId)` (ruling 6). If null → `invalid`; otherwise it is passed to `createStaff` / `claimPasswordlessStaff`.
  - Routes pass `session`.
  - Fix every caller tsc reports (no default left).
- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit` → 0. `grep -n 'actorRole: StaffRole = ' src/lib/admin/staff-queries.ts` → no lines.
- [ ] **Step 5: Commit** — `feat(golive): org users cannot mutate platform-admin users; actors are explicit`.

### Task 6: Platform switches — PATCH route, map gates, console (P3)

**Files:**
- Create: `src/lib/admin/platform-features.ts` (+`.test.ts`)
- Modify:
  - `src/app/api/platform/organizations/[id]/route.ts` (add `PATCH` beside `DELETE`)
  - `src/app/api/platform/organizations/route.ts:48-64` (each row gains `features: Features`)
  - `src/components/admin/nav-items.ts:52,137,159` (+test)
  - `src/components/admin/sidebar.tsx:89`, `src/components/admin/global-search.tsx:71`, `src/components/admin/dashboard-shell.tsx` (prop `mapEnabled`)
  - `src/app/admin/(dashboard)/layout.tsx` (`mapEnabled` from `parseFeatures(row.featureFlags).map`)
  - `src/app/admin/(dashboard)/map/page.tsx` (`notFound()` when off)
  - `src/app/api/admin/dispatch/map/route.ts`, `src/app/api/admin/mapkit-token/route.ts`
  - `src/components/admin/platform/platform-console.tsx`
- Test: `[id]/route.test.ts`, `nav-items.test.ts`, `dispatch/map/route.test.ts`, `mapkit-token/route.test.ts`

**Interfaces:**
- Consumes: `getFeatures`, `parseFeatures`, `featurePatchSchema`, `loadOrgRow` (Task 4).
- Produces:
  - `navGroupsFor(placement: SetupPlacement, opts: { readonly map: boolean }): readonly NavGroup[]`
  - `navLabelFor(pathname, placement, opts)`
  - `updateOrgFeatures(orgId: string, patch: Partial<Record<FeatureKey, boolean>>, actor: { userId: string; email: string }): Promise<Features | null>` — one `db.batch`:
    - `UPDATE organizations SET feature_flags = feature_flags || $patch WHERE id = $1 RETURNING feature_flags`;
    - a `platform_audit_log` insert (`action: "org_features_update"`, details `{ features: patch }`).
  - `PATCH /api/platform/organizations/[id]` with `{ features }` → `200 { features }` | 400 `INVALID_ID`/`VALIDATION_ERROR` | 401 | 403 (not platform, or cross-site Origin) | 404 | 429.

- [ ] **Step 1: Write the failing tests**
```ts
it("403 for a super_admin who is not a platform admin")
it("403 when Origin is cross-site")                          // isSameOriginRequest false
it("400 INVALID_ID for a non-UUID id; 400 VALIDATION_ERROR for {features:{}} and for unknown keys")
it("404 when the org does not exist")
it("200 returns merged features and writes one platform audit row with keys/booleans only")
it("429 after RATE_LIMITS.adminMutation.maxRequests")
it("omits /admin/map when map is off, for both placements")
it("keeps /admin/map when map is on")
it("dispatch/map and mapkit-token answer 404 NOT_FOUND when map is off")
it("updateOrgFeatures merges with || and scopes WHERE id = $1")   // PgDialect render
```
- [ ] **Step 2: Run** `npx vitest run src/app/api/platform src/components/admin/nav-items.test.ts src/app/api/admin/dispatch/map src/app/api/admin/mapkit-token src/lib/admin/platform-features.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - PATCH order: session → `isPlatformAdmin` → `isSameOriginRequest` → rate-limit key `platform:org-features:${userId}` → `isUuid` → `readJsonBody` + `z.object({ features: featurePatchSchema })` → `updateOrgFeatures`.
  - Thread `mapEnabled` from layout → `DashboardShell` → `Sidebar` / `GlobalSearch` / `useMobileTitle`.
  - Console: a "Switches" row per org — `Switch` controls "Map", "Review requests", "Pay links", "Show history". A failed save reverts the switch and shows "Couldn’t save the switch. Please try again."
- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit` → 0. Then:
  - Start dev with `PLATFORM_ADMIN_EMAILS=<dev owner email> PLATFORM_ORG_ID=00000000-0000-0000-0000-000000000001 npm run dev`.
  - Run `MINT_EMAIL=<dev owner email> node scripts/agent/screenshot-page.mjs /admin/platform 1440`.
  - Look at the shot.
- [ ] **Step 5: Commit** — `feat(golive): per-org platform switches; map gated off by default`.

### Task 7: Chick onboards by email — tightened promotion, owner invite, invite email (P2)

**Files:**
- Create: `src/lib/admin/invite-email.ts` (+`.test.ts`), `src/app/api/platform/organizations/[id]/owner-invite/route.ts` (+`route.test.ts`)
- Modify:
  - `src/lib/admin/invites.ts` — the promotion block `:416-461`; new `inviteEmailsLast24h`.
  - `src/app/api/admin/invites/route.ts:67-123`.
  - `src/components/admin/invite-dialog.tsx`, `src/components/admin/platform/platform-console.tsx`.
  - `src/app/api/platform/organizations/route.ts` — each row gains `hasOwnerEmail`.
- Test: `invites.test.ts`, `src/app/api/admin/invites/route.test.ts`

**Interfaces:**
- Consumes: `createInvite(org, input, actor)`, `loadInviter`, `isPlatformAdmin`, `MutationActor` (Task 5).
- Produces:
  - `buildInviteEmail(p: { orgName: string; url: string; role: InvitableRole; expiresAt: Date }): { subject: string; html: string; text: string }` — subject `You’re invited to ${orgName}`; the org name is escaped; no tracking params.
  - `inviteLink(token: string): string | null` — built from `NEXT_PUBLIC_APP_URL` only.
  - `inviteEmailsLast24h(organizationId: string): Promise<number>`
  - `deliverInvite(p: { organizationId; email; orgName; token; role; expiresAt; priorCount: number }): { emailed: boolean }` — `emailed` is true when `RESEND_API_KEY` is set, the link is non-null and `priorCount <= 19` (ruling 4). When emailed, it schedules `sendEmail` in `after()`.
  - `inviteResultView(r: { emailed: boolean; url?: string; email: string }): { kind: "emailed"; line: string } | { kind: "link"; url: string }` — the line is `Invite emailed to ${email}.`
  - `isOwnerPromotion(p: { ownerEmail: string | null; inviteEmail: string; inviteRole: InvitableRole; inviter: MutationActor | null }): boolean` — true only when the emails match (normalized), the role is `"admin"`, and `inviter !== null && isPlatformAdmin(inviter)`.
  - `POST /api/platform/organizations/[id]/owner-invite` → `201 { emailed, url? }` | 400 | 401 | 403 (incl. cross-site Origin) | 404 `NO_OWNER_EMAIL` | 409 | 429.
  - `POST /api/admin/invites` → `{ invite, emailed, url? }`. `url` is included only when not emailed and the actor is `super_admin` or a platform admin.

- [ ] **Step 1: Write the failing tests**
```ts
expect(isOwnerPromotion({ ownerEmail:"c@s.com", inviteEmail:"C@s.com", inviteRole:"admin", inviter: rchenPlatform })).toBe(true);
expect(isOwnerPromotion({ ...ok, inviteRole:"technician" })).toBe(false);
expect(isOwnerPromotion({ ...ok, inviter: orgSuperAdminNotPlatform })).toBe(false);
expect(isOwnerPromotion({ ...ok, inviter: null })).toBe(false);
expect(isOwnerPromotion({ ...ok, ownerEmail: null })).toBe(false);
expect(buildInviteEmail({ orgName:"<b>X</b>", url, role:"admin", expiresAt }).html).toContain("&lt;b&gt;X&lt;/b&gt;");
expect(buildInviteEmail(args).html).not.toMatch(/utm_|click/);
it("inviteLink is null without NEXT_PUBLIC_APP_URL and joins without a double slash")
it("emails in after() and omits url when RESEND_API_KEY is set")
it("returns url and emailed:false without RESEND_API_KEY for a super_admin")
it("returns emailed:false and no url for a plain admin without RESEND_API_KEY")
it("never builds the link from the request origin")
it("emails the 20th invite of 24h and not the 21st")          // priorCount 19 → true; 20 → false
it("owner-invite: 403 non-platform; 404 NO_OWNER_EMAIL; issues an admin invite to owner_email with the platform admin as actor")
```
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/invite-email.test.ts src/lib/admin/invites.test.ts src/app/api/admin/invites src/app/api/platform/organizations` → FAIL.
- [ ] **Step 3: Implement.**
  - `acceptInvite` decides promotion with `isOwnerPromotion` (the inviter Task 5 loads). The promotion UPDATEs themselves are unchanged.
  - The routes read `inviteEmailsLast24h` BEFORE `createInvite`.
  - Owner-invite route: platform gate → same-origin → rate-limit key `platform:owner-invite:${userId}` → `isUuid` → read `owner_email, name` → `createInvite(id, { email: ownerEmail, role: "admin" }, session)` → `deliverInvite`.
  - Console: a "Send owner invite" button on rows with `hasOwnerEmail`. It shows "Invite emailed.", or the copy link once.
- [ ] **Step 4: Run** → PASS (pair rule: filter on own files).
- [ ] **Step 5: Commit** — `feat(golive): owner promotion requires an admin invite from a platform admin; invites are emailed`.

### Task 8: Visibility primitives, viewer context and the coverage test (P6 foundation)

**Files:**
- Create:
  - `src/lib/admin/visibility.ts` (+test), `src/lib/admin/visibility-scan.ts` (+test), `src/lib/admin/visibility-coverage.test.ts`
  - `src/lib/admin/visibility-coverage/permanent.json`, `pending-requests.json`, `pending-customers.json`, `pending-money.json`, `pending-insights.json`
  - `src/lib/auth/viewer.ts`, `tests/integration/visibility-fixture.ts`
- Modify: `vitest.config.ts` — add `tests/integration/visibility-{requests,customers,money,insights}.test.ts` (Tasks 10–13 create them).

**Interfaces:**
- Produces (`visibility.ts`, pure):
  - `interface Visibility { readonly showHidden: boolean }`
  - `SHOW_ALL` (`{ showHidden: true }`) — for crons, AI and writers that tsc forces to choose.
  - `VISIBLE_ONLY` (`{ showHidden: false }`).
  - `visibleRows(table: { hiddenFromOrg: AnyPgColumn }, vis: Visibility): SQL` — `sql\`true\`` or `eq(table.hiddenFromOrg, false)`.
  - `visibleRowsSql(alias: string, vis: Visibility): SQL` — `TRUE` or `<alias>.hidden_from_org = false`; the alias must match `/^[a-z][a-z0-9_]*$/` or it throws.
  - `computeShowHidden(p: { isPlatformAdmin: boolean; previewing: boolean; showHistory: boolean }): boolean` = `(isPlatformAdmin && !previewing) || showHistory`.
- Produces (`viewer.ts`, `server-only`):
  - `interface ViewerContext extends Visibility { readonly session: AdminSessionPayload; readonly isPlatformAdmin: boolean; readonly features: Features; readonly preview: PreviewState | null; readonly uiRole: AdminRole | "technician" }`
  - `type PreviewState = { readonly status: "active"; readonly targetUserId: string; readonly targetName: string; readonly targetRole: AdminRole | "technician" } | { readonly status: "stale" }`
  - `getViewerContext = cache(async (): Promise<ViewerContext | null>)` — in Task 8, `preview` is null and `uiRole` is `session.role`; Task 15 reads the cookie.
  - A features error falls back to `DEFAULT_FEATURES` (`showHistory:false`), so an error can never reveal history.
- Produces (`visibility-scan.ts`, pure):
  - `FLAGGED_TABLES`: `customers`, `serviceRequests`, `invoices`, `estimates`, `customerSessions` and their snake names.
  - `CHILD_TABLES`: `payments`, `customerEquipment`, `messages`, `appointments`, `reviewRequests`, `communicationJobs`, `requestNotes`, `customerNotes`, `attachments` and their snake names.
  - `scanSource(path: string, source: string): ReadSite[]`
  - `interface ReadSite { readonly id: string; readonly reads: readonly { table: string; alias: string | null; kind: "flagged" | "child" }[]; readonly uncovered: readonly string[] }`
- Scanner rules:
  - **Chunks.** A chunk runs from one top-level `function` / `async function` / `const X =` (exported or not) to the next.
  - **Read patterns:** `.from(T`, `Join(T`, `FROM T [alias]`, `JOIN T [alias]` (any case), and `(FROM|JOIN)\s+\$\{(schema\.)?T\}\s*(alias)?`.
  - **Coverage is per table.**
    - A flagged drizzle read of `T` is covered by `visibleRows(T,` in the chunk.
    - A raw read is covered by `visibleRowsSql("<alias or table name>",` (either quote style).
    - A child read is covered when the chunk covers at least one flagged table (the parent join).
    - `uncovered` lists every table read that is not covered.
- Allowlist shape: `[{ "id": "<path>#<fn>" | "<path>#*" | "<dir>/", "reason": string }]` (`#*` = every chunk in the file).

- [ ] **Step 1: Write the failing tests**
```ts
expect(render(visibleRows(customers, VISIBLE_ONLY))).toBe('"customers"."hidden_from_org" = $1');   // params [false]
expect(render(visibleRows(customers, SHOW_ALL))).toBe("true");
expect(render(visibleRowsSql("sr", VISIBLE_ONLY))).toBe("sr.hidden_from_org = false");
expect(() => visibleRowsSql("sr; drop", VISIBLE_ONLY)).toThrow();
expect(computeShowHidden({ isPlatformAdmin:true, previewing:false, showHistory:false })).toBe(true);
expect(computeShowHidden({ isPlatformAdmin:true, previewing:true, showHistory:false })).toBe(false);
expect(computeShowHidden({ isPlatformAdmin:false, previewing:false, showHistory:true })).toBe(true);
// visibility-scan.test.ts
it("finds .from(customers) inside an exported async function")
it("finds raw FROM service_requests sr inside a const builder and needs visibleRowsSql('sr'")
it("finds JOIN ${serviceRequests} r and JOIN ${schema.customers} c")
it("a chunk filtering customers but reading invoices unfiltered reports invoices uncovered")
it("a payments read is covered when the chunk filters invoices")
it("ignores tables that share a prefix (customer_locations, invoice_lines)")
// visibility-coverage.test.ts — globs src/lib/**/*.ts and src/app/api/admin/**/*.ts (not *.test.ts)
it("every read site with an uncovered table is allowlisted")
it("no allowlist entry is stale (each id matches a site that still has an uncovered table)")
it("an id appears in at most one allowlist file")
```
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/visibility.test.ts src/lib/admin/visibility-scan.test.ts src/lib/admin/visibility-coverage.test.ts` → FAIL.
- [ ] **Step 3: Implement the modules.** `viewer.ts`: `getAdminSession` → `isPlatformAdmin` → `getFeatures` → `computeShowHidden`.
- [ ] **Step 4: Fill the allowlists exactly.**
  - **`pending-requests.json`** (Task 10):
    - `src/lib/admin/queries.ts#getRequests`, `#getRequestById`, `#buildDashboardStatsQuery`, `#buildDashboardOverdueInvoicesQuery`, `#getDashboardOverview`, `#placedByRequestQuery`, `#placedByVisitQuery`, `#getSchedulingCalendar`, `#getAgenda`, `#getCustomerBookings`, `#countUnscheduledRequests`
    - `src/lib/admin/conversation-queries.ts#buildNeedsActionCountQuery` (ruling 11)
    - `src/lib/admin/scheduling-queries.ts#listUnscheduledRequests`
    - `src/lib/admin/dispatch-exceptions-queries.ts#getDispatchExceptions`
    - `src/app/api/admin/dispatch/map/route.ts#GET`
  - **`pending-customers.json`** (Task 11):
    - `src/lib/admin/crm-queries.ts#getCustomers`, `#getCustomerById`
    - `src/lib/admin/conversation-queries.ts#getConversations`, `#getConversationById`
    - `src/lib/admin/search-queries.ts#searchCustomers`, `#searchInvoices`, `#searchJobs`, `#searchConversations`, `#searchEstimates`
    - `src/lib/reviews/review-queries.ts#listReviews`, `#getReviewStats`
    - `src/lib/admin/warranty-queries.ts#listExpiringWarranties`
  - **`pending-money.json`** (Task 12):
    - `src/lib/admin/invoice-queries.ts#collectedThisMonthCents`, `#getInvoiceSummaryStats`, `#listInvoices`, `#getInvoiceDetailById`
    - `src/lib/admin/estimate-queries.ts#getEstimatePipelineStats`, `#listEstimates`, `#getEstimateDetailById`
    - `src/lib/admin/financing-queries.ts#listFinancingApplications`
  - **`pending-insights.json`** (Task 13):
    - `src/lib/admin/reporting-queries.ts#getSalesReport`, `#getLeadSourceBreakdown`, `#getLocationBreakdown`, `#getTechnicianScorecards`
    - `src/lib/admin/ops-insights-queries.ts#getOpsInsights`
    - `src/lib/admin/operations-metrics-queries.ts#getOperationsMetrics`
    - `src/lib/admin/ai-insights-queries.ts#getAiInsights`
    - `src/lib/admin/bot-analytics-queries.ts#getBotAnalytics`
    - `src/lib/admin/onboarding-sql.ts#onboardingSelectSql`
  - **`permanent.json`** — every entry with a reason; function-level wherever an admin display could reach it:
    - **Module-level fragments (filtered by their caller):** `conversation-queries.ts#needsActionSql`, `#lastActivitySql`, `#hasContentSql`; `queries.ts#dashboardRequestSelect`, `#placedSelect`.
    - **Directory prefixes (no admin display reads through them):** `src/lib/tech/`, `src/lib/portal/`, `src/lib/integrations/`, `src/app/api/admin/integrations/`.
    - **`src/lib/communication/` functions:**
      - `booking-recovery.ts#recoverAbandonedBookings`, `#recoverAbandonedWebSessions`
      - `job-queue.ts#processPendingJobs`, `#retryFailedJobs`, `#getCommunicationJobStatus`
      - `money-triggers.ts#getCustomerContact`, `#sendInvoiceReminder`, `#sendInvoicePayLink`, `#sendOverdueInvoiceReminders`
      - `observability.ts#getCommsOutcomeSummary` (ruling 12)
    - **`src/lib/ai/` functions:**
      - `account-tools.ts#getOpenBalance`, `#getUpcomingAppointment`, `#requestReschedule`
      - `account-zips.ts#loadOnFileZips`
      - `compact-session.ts#compactSessionIfNeeded`
      - `customer-context.ts#loadCustomerContextById`
      - `dispatch/signals.ts#loadDispatchSignals`, `#loadJobCoords`, `#loadChainOrigins`
      - `session-outcome.ts#summarizeAndClassifySession`
      - `voice-turn.ts#voiceReply`
    - **Other lib functions:**
      - `src/lib/context/customer-profile.ts#loadCustomerProfile`
      - `src/lib/requests/submit-session-request.ts#submitSessionServiceRequest`
      - `src/lib/forecasting/rollups.ts#refreshDemandDaily`, `#refreshRevenueDaily`
      - `src/lib/dispatch/delay-detection.ts#findLateJobsForOrg`
      - `src/lib/forms/form-gates.ts#visitGateSql`, `#requestGateSql`, `#readFormGatesSql`
      - `src/lib/db/backfill-customer-hashes.ts#backfill`, `src/lib/db/cleanup-conversations.ts#main`, `src/lib/db/tenant.ts#(top)`
    - **`src/lib/admin` files (`#*`):**
      - writers: `invoice-field-writes.ts`, `invoice-payment-writes.ts`, `estimate-billing-sql.ts`, `visit-move-sql.ts`, `visit-one-guard.ts`, `current-visit.ts`, `appointment-queries.ts`, `assignment-queries.ts`
      - erasure: `erasure-queries.ts`, `erasure-sql.ts`
      - exports: `export-queries.ts`, `accounting-export.ts`
      - id-keyed: `form-queries.ts`, `attachment-queries.ts`, `tag-entity-lookup.ts`
      - writer / send / cron / intake: `crm-equipment-queries.ts`, `notify-assignment.ts`, `membership-visit-queries.ts`, `create-request-queries.ts`
      - ruling 12: `timesheet-admin-queries.ts`
      - `golive-marking-sql.ts` — the go-live marking writer must see all rows. Task 9 creates it before Task 8 runs.
    - **`src/lib/admin` functions:**
      - `queries.ts#assignTechnician`, `#reassignTechnician`, `#updateRequestStatus`, `#scheduleRequest`, `#addRequestNote`
      - `crm-queries.ts#findCustomerMatchCandidates`, `#findLegacyCustomerMatch`, `#deleteCustomer`, `#archiveCustomer`, `#findNativeContactClash`, `#unarchiveCustomer`, `#updateCustomerContact`
      - `invoice-queries.ts#createInvoiceFromSoldEstimate`, `#createRequestEstimateInvoice`, `#takePayment`, `#refundPayment`, `#listStuckPayments`, `#reconcilePayment`, `#unclaimInvoiceSql`, `#getInvoiceCustomerId`, `#voidInvoice`, `#listInvoiceReminders`
      - `estimate-queries.ts#approveEstimate`, `#regenerateApprovalToken`, `#markEstimateSold`, `#getEstimateForApproval`, `#customerInOrg`
      - `scheduling-queries.ts#checkScheduleConflict`, `#getScheduledJobsForRange`, `#rescheduleRequest`, `#placeAndAssignRequest`, `#unscheduleRequest`, `#assessBookingQualityForRequest`, `#ensureEstimatedDuration`, `#loadJobClassification`, `#suggestTechnicians`
      - `conversation-queries.ts#deleteConversation`, `warranty-queries.ts#getCustomerContact`, `financing-queries.ts#createFinancingApplication`
    - **Reviews:** `src/lib/reviews/review-queries.ts#getCustomerContact`, `#recordReviewResponse`, `#getReviewByToken`.
    - **Routes under `src/app/api/admin/`:**
      - `conversations/[id]/message/route.ts#POST`
      - `customers/[id]/contacts/route.ts#customerExists`
      - `customers/[id]/locations/route.ts#GET`
      - `invoices/[id]/finalize/route.ts#POST`
      - `invoices/[id]/payments/route.ts#invoiceCustomerId`
      - `communications/templates/[id]/route.ts#DELETE`
      - `customers/[id]/bookings/route.ts#(top)` (comment match)
  - **Unlisted sites.** If the first run reports a site in no list, it goes into `permanent.json` only if it fits one of these reasons. Otherwise STOP and report it.
- [ ] **Step 5: Write the fixture.** `visibility-fixture.ts` exports `seedVisibilityOrg(): Promise<{ org; visible: Ids; hidden: Ids; cleanup() }>`. Each `Ids` holds a customer, a session (status `submitted`), a request with an upcoming appointment, an open invoice, an open estimate, a payment, a message, a review request and customer equipment. The hidden set is marked by UPDATE after insert.
- [ ] **Step 6: Run** → PASS (pair rule).
- [ ] **Step 7: Commit** — `feat(golive): visibility predicate, viewer context, per-table coverage test`.

### Task 9: Go-live marking script (P6)

**Files:**
- Create: `src/lib/admin/golive-marking-sql.ts` (+`.test.ts`), `scripts/agent/golive-hide-history.mjs`, `tests/integration/golive-marking.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces (pure; the timezone fallback is `BUSINESS_TIME_ZONE` from `src/lib/admin/calendar-time.ts:27`):
  - `type MarkingMode = "history" | "empty"`
  - `todayStartSql(org: string): SQL` = `date_trunc('day', now() AT TIME ZONE tz) AT TIME ZONE tz`, where `tz = COALESCE((SELECT after_hours_config->>'timezone' FROM organization_settings WHERE organization_id = $org), $default)`.
  - `visitFromTodaySql(org)` — `service_requests.scheduled_date >= today` OR an `appointments` row with `cancelled_at IS NULL AND COALESCE(starts_at, scheduled_date) >= today`.
  - `keptRequestIdsSql(org, mode)`:
    - history: `status NOT IN ('completed','cancelled')`, or a visit from today, or referenced by a kept invoice or estimate;
    - empty: a visit from today only.
  - `keptInvoiceIdsSql(org, mode)` — history: ruling 10; empty: none.
  - `keptEstimateIdsSql(org, mode)` — history: `status = 'open'`; empty: none.
  - `keptSessionIdsSql(org, mode)` — sessions of kept requests ∪ sessions with `status IN ('chatting','extracting','confirmed')` (ruling 16, both modes).
  - `keptCustomerIdsSql(org, mode)` — customers of kept requests, invoices, estimates and sessions.
  - `markStatements(org, mode): SQL[]` — five `UPDATE … SET hidden_from_org = true WHERE organization_id = $org AND NOT hidden_from_org AND id NOT IN (<kept>)`.
  - `unhideStatements(org): SQL[]`
  - `dryRunSql(org): SQL` — per table: `total`, `hide_history`, `hide_empty`. Plus `old_open_requests_kept` (kept in history, open, `created_at < now() - interval '60 days'`, no visit from today) and `open_ar_cents_hidden_in_empty`.
- CLI: `npx tsx scripts/agent/golive-hide-history.mjs --org <uuid> [--mode history|empty] [--apply [--reapply]] [--unhide] [--prod]`.
  - Dry run by default; it prints both modes.
  - In empty mode it also prints: "Warning: open invoices will be hidden, but dunning keeps reminding those customers."
  - `--apply` runs one `db.batch(markStatements)` through drizzle neon-http. `DATABASE_URL` comes from the env, else from `.env.local`.
  - Refusals (ruling 5): exit 1 with a one-line reason.

- [ ] **Step 1: Write the failing pure test** (PgDialect renders):
  - `every statement binds organization_id = $org on every table reference`
  - `history keeps non-terminal requests; empty does not`
  - `both modes keep chatting/extracting/confirmed sessions`
  - `a visit means cancelled_at IS NULL`
  - `kept invoices exclude FieldPulse and HCP drafts`
  - `statements never DELETE`
  - `unhide covers exactly the five tables`
  - `enum literals are cast`
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/golive-marking-sql.test.ts` → FAIL.
- [ ] **Step 3: Implement** the builders and the script.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Write and run** `golive-marking.test.ts` (throwaway org; `after_hours_config.timezone = 'America/Chicago'` for the boundary case):
  - `history keeps open request, upcoming-visit completed request, open invoice + its customer/request/session, native draft, open estimate, chatting session + its customer`
  - `history hides completed request without future visit, paid invoice, FieldPulse draft, sold estimate, abandoned orphan session`
  - `empty keeps only upcoming-visit requests, resumable sessions and their customers`
  - `a cancelled future appointment does not keep its request`
  - `visit at 00:30 local today is kept; 23:30 yesterday is hidden`
  - `a second apply without --reapply refuses; markStatements re-run changes 0 rows`
  - `unhide restores every row`
  - `script refuses ep-withered-hill without --prod` (spawn with a fake URL; exit 1; no connection made)

  Run `VITEST_INTEGRATION=1 npx vitest run tests/integration/golive-marking.test.ts` → PASS.
- [ ] **Step 6: Commit** — `feat(golive): go-live marking script with dry run for both modes`.

### Task 10: Sweep A — requests, dispatch, calendar, dashboard, needs-action count (P6)

**Files:**
- Modify:
  - `src/lib/admin/queries.ts` — `getRequests:138`, `getRequestById:267`, `buildDashboardStatsQuery:1173`, `getDashboardStats:1256`, `buildDashboardOverdueInvoicesQuery:1346`, `getDashboardOverview:1399`, `placedByRequestQuery:1547`, `placedByVisitQuery:1568`, `getDispatchBoard:1610`, `getSchedulingCalendar:1681`, `getMonthCalendar:1785`, `getAgenda:1869`, `getCustomerBookings:1964`, `countUnscheduledRequests:2033`.
  - `src/lib/admin/conversation-queries.ts:168` (`buildNeedsActionCountQuery`). Its call inside `getConversations` (`:305`) passes `SHOW_ALL` with `// TODO(Task 11): pass vis`, because `getConversations` only gains `vis` in Task 11.
  - `src/lib/admin/scheduling-queries.ts:337`, `src/lib/admin/dispatch-exceptions-queries.ts:26`, `src/app/api/admin/dispatch/map/route.ts`.
  - Every route tsc reports, at least: `requests/route.ts`, `requests/[id]/route.ts` (GET), `calendar/route.ts`, `calendar/unscheduled-count/route.ts`, `agenda/route.ts`, `dispatch/route.ts`, `overview/route.ts`, `stats/route.ts`, `customers/[id]/bookings/route.ts`, `conversations/needs-action-count/route.ts`.
  - Delete `pending-requests.json`.
- Test: `tests/integration/visibility-requests.test.ts`; route tests that assert call args (e.g. `calendar/route.test.ts`)

**Interfaces:**
- Consumes: `Visibility`, `visibleRows`, `visibleRowsSql`, `SHOW_ALL`, `getViewerContext`, `seedVisibilityOrg` (Task 8).
- Produces:
  - Each listed function gains a required last parameter `vis: Visibility`.
  - `getRequestById(org, id, vis)` returns `null` for a hidden row → the existing 404.
  - Routes use `getViewerContext()` (its `.session` replaces `session`) and pass `viewer`.
  - Non-admin callers pass `SHOW_ALL` with a one-line reason comment.

- [ ] **Step 1: Write the failing integration test** (fixture; each case runs with `VISIBLE_ONLY`, then with `SHOW_ALL`):
  - `getRequests excludes the hidden request; total counts only visible`
  - `getRequestById returns null for a hidden id with VISIBLE_ONLY and the row with SHOW_ALL`
  - `getSchedulingCalendar, getDispatchBoard and getMonthCalendar place only the visible visit`
  - `getAgenda and getCustomerBookings skip hidden requests`
  - `countUnscheduledRequests and listUnscheduledRequests ignore hidden`
  - `getDashboardOverview stats, overdue tiles and the needs-action count exclude hidden rows`
  - `buildNeedsActionCountQuery ignores a hidden session that needs action`
  - `getDispatchExceptions ignores hidden`
- [ ] **Step 2: Run** `VITEST_INTEGRATION=1 npx vitest run tests/integration/visibility-requests.test.ts` → FAIL.
- [ ] **Step 3: Implement.** AND `visibleRows(<table>, vis)` / `visibleRowsSql('<alias>', vis)` into every WHERE, once per flagged table read. Fix every caller tsc reports. Delete `pending-requests.json`.
- [ ] **Step 4: Run** the integration test → PASS. `npx vitest run src/lib/admin/visibility-coverage.test.ts src/app/api/admin` → PASS. `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** — `feat(golive): requests, calendar, dispatch, dashboard and needs-action count read visible rows`.

### Task 11: Sweep B — customers, conversations, search, reviews, warranties (P6)

**Files:**
- Modify:
  - `src/lib/admin/crm-queries.ts` (`getCustomers:112`, `getCustomerById:379`)
  - `src/lib/admin/conversation-queries.ts` (`getConversations:208`, `getConversationById:442`). Also replace Task 10's `SHOW_ALL` + `TODO(Task 11)` at the `buildNeedsActionCountQuery` call (`:305`) with `vis`.
  - `src/lib/admin/search-queries.ts` (`searchCustomers:89`, `searchInvoices:130`, `searchJobs:172`, `searchConversations:243`, `searchEstimates:421`)
  - `src/lib/reviews/review-queries.ts` (`listReviews:274`, `getReviewStats:349`)
  - `src/lib/admin/warranty-queries.ts` (`listExpiringWarranties:59`)
  - Every route tsc reports (customers, customers/[id], conversations, conversations/[id], search, reviews, warranties).
  - Delete `pending-customers.json`.
- Test: `tests/integration/visibility-customers.test.ts`

**Interfaces:** Same pattern as Task 10.
- Children filter through their parents: `customer_equipment` through `customers`, `messages` through `customer_sessions`, `review_requests` through their request and customer.
- `getCustomerById` and `getConversationById` return `null` when the row is hidden.

- [ ] **Step 1: Write the failing integration test** (fixture):
  - `getCustomers list and total exclude the hidden customer`
  - `getCustomerById returns null for hidden`
  - `getConversations skips hidden sessions`
  - `getConversations' needs-action count excludes a hidden session` (pins the `:305` change; `grep -n "TODO(Task 11)" src` → no lines)
  - `getConversationById returns null for a hidden session`
  - `each search* omits hidden rows and returns them with SHOW_ALL`
  - `listReviews and getReviewStats skip reviews of hidden requests`
  - `listExpiringWarranties skips equipment of hidden customers`
- [ ] **Step 2: Run** `VITEST_INTEGRATION=1 npx vitest run tests/integration/visibility-customers.test.ts` → FAIL.
- [ ] **Step 3: Implement** the pattern. Delete `pending-customers.json`.
- [ ] **Step 4: Run** → PASS. Coverage test + `npx vitest run src/app/api/admin/customers src/app/api/admin/conversations src/app/api/admin/search src/app/api/admin/reviews` → PASS. `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** — `feat(golive): customers, conversations, search and reviews read visible rows`.

### Task 12: Sweep C — invoices, estimates, payments, financing (P6)

**Files:**
- Modify:
  - `src/lib/admin/invoice-queries.ts` (`collectedThisMonthCents:902`, `getInvoiceSummaryStats:1041`, `listInvoices:1126` — both `whereClause` and `whereClauseNoSource:1186`; `getInvoiceDetailById:1454`)
  - `src/lib/admin/estimate-queries.ts` (`getEstimatePipelineStats:401`, `listEstimates:456`, `getEstimateDetailById:726`)
  - `src/lib/admin/financing-queries.ts` (`listFinancingApplications:185`)
  - Every route tsc reports.
  - Delete `pending-money.json`.
- Test: `tests/integration/visibility-money.test.ts`

**Interfaces:** Same pattern.
- `payments` filter through `invoices`.
- Detail getters return `null` when hidden.
- Money writers stay untouched.

- [ ] **Step 1: Write the failing integration test** (fixture):
  - `listInvoices rows and getInvoiceSummaryStats AR tiles exclude the hidden invoice`
  - `listInvoices tab counts (whereClauseNoSource) exclude the hidden invoice`
  - `collectedThisMonthCents ignores payments on hidden invoices`
  - `getInvoiceDetailById returns null for hidden`
  - `listEstimates and getEstimatePipelineStats skip hidden; getEstimateDetailById null`
  - `listFinancingApplications skips applications on hidden invoices`
- [ ] **Step 2: Run** `VITEST_INTEGRATION=1 npx vitest run tests/integration/visibility-money.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Delete `pending-money.json`.
- [ ] **Step 4: Run** → PASS. Coverage test + `npx vitest run src/app/api/admin/invoices src/app/api/admin/estimates tests/api/money-routes.test.ts` → PASS. `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** — `feat(golive): invoice, estimate and financing lists read visible rows`.

### Task 13: Sweep D — reports, insights, operations, bot analytics, onboarding signals (P6)

**Files:**
- Modify:
  - `src/lib/admin/reporting-queries.ts` (`getSalesReport:98`, `getLeadSourceBreakdown:324`, `getLocationBreakdown:498`, `getTechnicianScorecards:668`)
  - `src/lib/admin/ops-insights-queries.ts:31`, `src/lib/admin/operations-metrics-queries.ts:138`, `src/lib/admin/ai-insights-queries.ts:38`, `src/lib/admin/bot-analytics-queries.ts:85`
  - `src/lib/admin/onboarding-sql.ts:13` (`any_request`, `completed_request` → `visibleRowsSql(…, VISIBLE_ONLY)`; `booked_assigned` → `appointments a JOIN service_requests r ON r.id = a.service_request_id AND r.organization_id = $o AND <visibleRowsSql('r', VISIBLE_ONLY)>`; ruling 2, no new param)
  - Every route tsc reports.
  - Delete `pending-insights.json`.
- Test: `tests/integration/visibility-insights.test.ts`, `tests/integration/onboarding-state.test.ts` (stays green)

**Interfaces:** A required `vis: Visibility` on the eight report/insight functions. Children filter through their parents: `payments` through `invoices`, `messages` through `customer_sessions`, `appointments` through `service_requests`.

- [ ] **Step 1: Write the failing integration test** (fixture):
  - `getSalesReport totals exclude payments on hidden invoices and hidden estimates`
  - `lead source, location and technician scorecards count only visible requests`
  - `getOpsInsights, getOperationsMetrics, getAiInsights, getBotAnalytics ignore hidden rows`
  - `onboarding any_request, booked_assigned and completed_request are false when the only requests are hidden`
- [ ] **Step 2: Run** `VITEST_INTEGRATION=1 npx vitest run tests/integration/visibility-insights.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Delete `pending-insights.json`; only `permanent.json` remains.
- [ ] **Step 4: Run** → PASS. `VITEST_INTEGRATION=1 npx vitest run tests/integration/onboarding-state.test.ts` → PASS. Coverage test → PASS. `npx vitest run` ≥ baseline. `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** — `feat(golive): reports, insights, operations and onboarding signals read visible rows`.

---
**CUT LINE A — Must ends here.**
---

### Task 16: Speed S1 — measure time to frame and first row (runs alone, first after cut line A)

**Files:**
- Create: `scripts/agent/measure-latency.mjs`, `src/lib/admin/latency-stats.ts` (+`.test.ts`)

**Interfaces:**
- Produces:
  - `percentile(samples: readonly number[], p: number): number` (nearest-rank).
  - `formatLatencyTable(rows: readonly { path: string; frame: number[]; firstRow: number[] }[]): string`.
  - `LATENCY_PAGES: readonly string[]` — the nav hrefs with map off.
- CLI: `node scripts/agent/measure-latency.mjs [--base http://localhost:3000] [--runs 5] [--out <file>]`.
  - The session comes from `MINT_EMAIL` minting on localhost; on any other base it comes from the `HVAC_SESSION` env, which the user supplies.
  - Each run loads `/admin`, clicks the sidebar link, and records frame and first row as defined in ruling 14.

- [ ] **Step 1: Write the failing test**:
  - `percentile([5,1,3,2,4],50) === 3`
  - `percentile([5,1,3,2,4],90) === 5`
  - `formatLatencyTable` gives one aligned row per path with p50/p90
  - `LATENCY_PAGES equals navGroupsFor('operations', { map: false }) hrefs`
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/latency-stats.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Write the S5a/S5 notes in the task report:
  - the Turbopack dev and filesystem-cache status, citing the option from `node_modules/next/dist/docs/`;
  - the Vercel compute mode and function memory, from read-only `vercel project inspect`;
  - that localhost numbers cross the Pacific.
- [ ] **Step 4: Run** → PASS. Then the baseline: `npm run build && npm run start` (background), then `node scripts/agent/measure-latency.mjs --runs 5 --out <scratchpad>/latency-before.txt`. Stop the server.
- [ ] **Step 5: Commit** — `feat(speed): time-to-frame and time-to-first-row measurement`.

### Task 14: Preview cookie and read-only proxy (P7 core)

**Files:**
- Create: `src/lib/auth/preview-cookie.ts` (+test), `src/lib/auth/preview-gate.ts` (+test), `src/lib/admin/preview-targets.ts`, `src/app/api/admin/preview/route.ts` (+test), `src/app/api/admin/preview/exit/route.ts` (+test)
- Modify: `src/proxy.ts`, `src/app/api/auth/logout/route.ts` (also deletes `hvac_preview`)

**Interfaces:**
- Produces:
  - `PREVIEW_COOKIE = "hvac_preview"`, `PREVIEW_MAX_AGE_S = 7200`.
  - `interface PreviewClaims { readonly adminUserId: string; readonly targetUserId: string; readonly exp: number }`.
  - `signPreviewCookie(c: PreviewClaims, authSecret: string): Promise<string>`.
  - `verifyPreviewCookie(value: string, authSecret: string, nowS?: number): Promise<PreviewClaims | null>` — ruling 3 key; verified with `crypto.subtle.verify`.
  - `previewCookieOptions()` → `{ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 7200 }`.
  - `normalizePreviewPath(pathname: string): string | null`:
    - `decodeURIComponent`, collapse repeated `/`, strip a trailing `/`, lowercase;
    - `null` when decoding fails, and null is treated as refuse.
  - `previewGate(method: string, pathname: string): "allow" | "refuse"`:
    - GET/HEAD are allowed except paths in `PREVIEW_GET_DENY`;
    - every other method is refused except `POST /api/admin/preview/exit` and `POST /api/auth/logout`.
  - `PREVIEW_GET_DENY` (GET handlers whose body writes):
    - `/api/auth/google/start`, `/api/auth/google/callback`, `/api/auth/signup/callback`
    - `/api/admin/integrations/google/connect`, `/api/admin/integrations/google/callback`
    - `/api/admin/export`, `/api/admin/accounting/export`
    - `/api/platform/organizations/<uuid>/export`
  - `previewProxyDecision(p: { method: string; pathname: string; sessionToken: string | undefined; previewCookie: string | undefined; authSecret: string; nowS?: number }): Promise<{ action: "pass" } | { action: "refuse" } | { action: "clear" }>`:
    - `clear` → the request proceeds and the response deletes the cookie;
    - `refuse` → 403 `{ success:false, error:{ message:"Read-only while viewing as another user", code:"PREVIEW_READ_ONLY" } }`.
  - `listPreviewTargets(orgId: string, excludeUserId: string): Promise<{ userId; name; role }[]>` — active users only.
  - `GET /api/admin/preview` → `{ targets }` (platform admin only).
  - `POST /api/admin/preview` `{ userId }` → 204 + cookie | 403 (not platform admin, or cross-site) | 404 (target not an active same-org user) | 409 `ALREADY_PREVIEWING`.
  - `POST /api/admin/preview/exit` → 204, cookie cleared.
  - Audit rows `preview_start` and `preview_exit` carry `{ targetUserId }`.

- [ ] **Step 1: Write the failing tests**
```ts
// preview-cookie.test.ts
it("round-trips claims"); it("rejects a tampered payload"); it("rejects a signature made with AUTH_SECRET directly")
it("rejects exp in the past"); it("rejects a malformed value without throwing")
// preview-gate.test.ts
expect(previewGate("GET", "/admin/customers")).toBe("allow");
expect(previewGate("POST", "/api/admin/requests")).toBe("refuse");
expect(previewGate("PATCH", "/api/platform/organizations/x")).toBe("refuse");
expect(previewGate("POST", "/api/communications/send")).toBe("refuse");
expect(previewGate("POST", "/api/admin/preview/exit")).toBe("allow");
expect(previewGate("POST", "/api/auth/logout")).toBe("allow");
expect(previewGate("GET", "/api/admin/export")).toBe("refuse");
expect(previewGate("GET", "/api/admin/export/")).toBe("refuse");
expect(previewGate("GET", "/api/admin/%65xport")).toBe("refuse");
expect(previewGate("GET", "//api//admin/export")).toBe("refuse");
expect(previewGate("GET", "/API/ADMIN/EXPORT")).toBe("refuse");
expect(previewGate("GET", "/api/admin/%E0%A4%A")).toBe("refuse");
expect(previewGate("GET", "/api/platform/organizations/00000000-0000-0000-0000-000000000001/export")).toBe("refuse");
expect(previewGate("GET", "/api/admin/integrations/google/connect")).toBe("refuse");
// previewProxyDecision
it("valid bound cookie + POST /api/admin/customers → refuse (403 PREVIEW_READ_ONLY)")
it("valid bound cookie + GET /admin → pass")
it("cookie bound to another admin → clear, and the request proceeds")
it("expired cookie → clear")
it("cookie present, no session token → clear")
it("valid bound cookie + POST /api/auth/logout → pass")
// route tests
it("403 for a super_admin who is not a platform admin"); it("404 for an inactive target and for another org's user")
it("204 sets hvac_preview HttpOnly SameSite=Strict Max-Age=7200 bound to the admin")
it("403 when Origin is cross-site"); it("exit clears the cookie and writes preview_exit")
```
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/preview-cookie.test.ts src/lib/auth/preview-gate.test.ts src/app/api/admin/preview` → FAIL.
- [ ] **Step 3: Implement.** `proxy()` calls `previewProxyDecision` first for every matched path whenever `hvac_preview` is present.
- [ ] **Step 4: Run** → PASS (pair rule). After both pair members commit, run a dev probe: start a preview → `POST /api/admin/customers` gives 403 `PREVIEW_READ_ONLY` → `GET` gives 200 → exit gives 204.
- [ ] **Step 5: Commit** — `feat(golive): view-as cookie and read-only proxy`.

### Task 17: Speed S2 — instant frame for every admin route

**Files:**
- Create: `src/app/admin/(dashboard)/loading.tsx`, `src/lib/admin/loading-coverage.test.ts`

**Interfaces:** None. The generic `loading.tsx` composes `PageShell`, a header skeleton (as in `customers/loading.tsx`) and one `SkeletonTable`. The four existing route `loading.tsx` files stay.

- [ ] **Step 1: Write the failing test.** `every admin page directory resolves a loading.tsx at its own level or an ancestor up to (dashboard)`.
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/loading-coverage.test.ts` → FAIL.
- [ ] **Step 3: Implement** the generic `loading.tsx`.
- [ ] **Step 4: Run** → PASS (pair rule). Commit (Step 5).
- [ ] **Step 4b: After BOTH pair members have committed** (Task 14 and Task 17):
  - Take the visual checks by screenshotting right after click at 1440: `/admin`, `/admin/calendar`, `/admin/estimates/<id>`, `/admin/customers/<id>`.
  - Add a dedicated skeleton only for a route whose layout visibly shifts; commit it separately (`feat(speed): dedicated skeleton for <route>`).
  - The controller then re-measures into `<scratchpad>/latency-after-s2.txt`. Target: every frame < 100 ms locally.
- [ ] **Step 5: Commit** — `feat(speed): generic admin loading frame`.

### Task 15: View-as rendering — viewer, banner, onboarding, console, scripts (P7)

**Files:**
- Create: `src/components/admin/preview-banner.tsx`, `src/lib/admin/preview-banner-copy.ts` (+test), `src/lib/auth/viewer.test.ts`, `scripts/agent/mint-preview-cookie.mjs`
- Modify:
  - `src/lib/auth/viewer.ts`
  - `src/app/admin/(dashboard)/layout.tsx` (banner; `role={viewer.uiRole}`), `src/components/admin/dashboard-shell.tsx`
  - `src/lib/admin/onboarding-queries.ts:66`; `src/app/api/admin/onboarding/route.ts` (`write: !isDemoOrg(org) && !viewer.preview`)
  - `platform-console.tsx` ("View as")
  - `scripts/agent/screenshot-page.mjs` and `scripts/agent/measure-latency.mjs` (`--preview-as <userId>`)
- Test: `viewer.test.ts`, `onboarding/route.test.ts`, `preview-banner-copy.test.ts`

**Interfaces:**
- Consumes: `verifyPreviewCookie`, `PREVIEW_COOKIE` (Task 14); `ViewerContext`, `PreviewState`, `computeShowHidden` (Task 8).
- Produces:
  - `previewBannerLine(p: PreviewState): string` — `Viewing as ${name} · read-only`, or the ruling 9 line.
  - The "Exit" button POSTs exit, then calls `location.assign('/admin/platform')`.
  - `getOnboarding(org, { demo, write, googleEnabled, appUrl, now? })` — no stamp, grandfathering or `firstSeenAt` write when `write` is false.
  - `mint-preview-cookie.mjs <targetUserId>` (uses `MINT_EMAIL`).

- [ ] **Step 1: Write the failing tests**
```ts
it("platform admin, no cookie → showHidden true, preview null, uiRole session.role")
it("valid cookie, active same-org target → preview active, showHidden false, uiRole target role")
it("valid cookie, target inactive → preview stale, showHidden false")
it("cookie bound to another admin → preview null")
it("non-platform admin with a valid cookie → preview null")
it("showHistory on → showHidden true even while previewing")
it("onboarding GET passes write:false while previewing and never runs the stamp statement")
expect(previewBannerLine({ status:"active", targetUserId:"u", targetName:"Chick Spears", targetRole:"super_admin" })).toBe("Viewing as Chick Spears · read-only");
```
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/viewer.test.ts src/app/api/admin/onboarding src/lib/admin/preview-banner-copy.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `viewer.ts` reads the cookie only for platform admins, then loads the target with one indexed select. The console's "View as" uses a `Select` with a `SelectValue` formatter.
- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit` → 0. `node scripts/agent/screenshot-page.mjs /admin 1440 --preview-as <dev chick id>` — look at it: banner present, nav for the target role, history hidden.
- [ ] **Step 5: Commit** — `feat(golive): view as — banner, target role, read-only onboarding, console entry`.

### Task 18: P8 — walk every admin page as Chick, one fix wave (controller-run)

**Files:** Whatever the defects need. Each fix is its own commit with full gates.

**Procedure** (DEV only; queue guard first; no request is created through the API):

1. **Dev mirror** (SQL on the DEV branch):
   - `UPDATE organizations SET name='Spears Services' WHERE id='00000000-0000-0000-0000-000000000001'`.
   - Pick an active non-`@demo-hvac.com` `super_admin` as the dev owner. If there is none, insert `rchen.dev@throwaway.example`.
   - Insert the Chick-like user: `INSERT INTO users (organization_id,email,name,role,is_active,password_hash) VALUES ('00000000-0000-0000-0000-000000000001','chick.dev@throwaway.example','Chick Spears','super_admin',true,NULL)`.
2. **Marking.** Dry run `npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001` and record both modes. Then apply with `--apply --mode history`.
3. **Onboarding reset** — the handover step 7 SQL, run on DEV.
4. **Start dev:** `PLATFORM_ADMIN_EMAILS=<dev owner> PLATFORM_ORG_ID=00000000-0000-0000-0000-000000000001 npm run dev` (background; `DEMO_MODE_ORG_IDS` unset), with `export MINT_EMAIL=<dev owner>`.
5. **Walk.** A reviewer subagent (explicit model) runs, per page at widths 1440 and 390: `node scripts/agent/screenshot-page.mjs <path> <width> <scratchpad>/p8/<slug>-<width>.png --preview-as <chick id>`, and looks at every shot.
   - **Pages:** `/admin`, `/admin/calendar`, `/admin/dispatch`, `/admin/requests`, `/admin/requests?request=<visible id>`, `/admin/customers`, `/admin/customers/<visible id>`, `/admin/conversations`, `/admin/estimates`, `/admin/estimates/<visible id>`, `/admin/invoices`, `/admin/invoices/<visible id>`, `/admin/pricebook`, `/admin/inventory`, `/admin/membership-plans`, `/admin/reviews`, `/admin/communications/templates`, `/admin/accounting`, `/admin/operations`, `/admin/reports`, `/admin/insights`, `/admin/technicians`, `/admin/staff`, `/admin/audit-log`, `/admin/integrations`, `/admin/fieldpulse-import`, `/admin/settings`, `/admin/settings/billing`, `/admin/settings/forms/<form id>`, `/admin/setup` and each guided step's deep link, `/admin/map` (expect 404).
   - **Also check:** a hidden id's detail URL (expect 404), and the invite email (render `buildInviteEmail` to `<scratchpad>/p8/invite.html` and screenshot it).
   - **Technician side:** `/tech/guide` with `--tech` (preview only if Task 19 shipped).
6. **Defects.** Log them in `<scratchpad>/p8/defects.md`: demo-like copy, confusing empty states, setup steps that don't fit, dead links, errors. Then one fix wave (`fix(golive-p8): …`, each with a test if it's logic or a screenshot if it's visual) and a re-walk of the touched pages.
7. **Speed tables** as the owner and with `--preview-as <chick id>` → for the handover doc.
8. **Cleanup.** Stop the server and delete the shots. Dev data stays (`--unhide` reverses the marking).

- [ ] **Step 1:** Steps 1–4; record counts.
- [ ] **Step 2:** Walk; write the ledger.
- [ ] **Step 3:** Fix wave + re-walk.
- [ ] **Step 4:** Speed tables; stop the server.

---
**CUT LINE B — Should ends here.**
---

### Task 19: Technician preview of `/tech/*` (P7 stretch)

**Files:**
- Modify:
  - `src/lib/auth/tech-session.ts` (+test)
  - `src/lib/tech/guide-queries.ts:23` (`getGuide` gains `opts: { write: boolean }`; +test)
  - `src/app/api/tech/guide/route.ts:21-25`
  - `src/proxy.ts` (matcher adds `"/tech/:path*"`)
  - `src/lib/auth/preview-gate.ts` (+test)

**Interfaces:**
- Produces:
  - `getTechSession()` falls back to a synthetic `{ userId: target, organizationId, email, name, role: "technician", preview: true }` only when ALL of these hold:
    - there is no `hvac_tech_session`;
    - there is an admin session AND `isPlatformAdmin(session)`;
    - the preview cookie verifies and is bound to that session;
    - the target is an active technician of the session's org.
  - `getGuide(org, userId, { write })` — no `guideStampSql` when `write` is false. The route passes `write: !session.preview`.
  - `previewGate` refuses every non-GET under `/api/tech/`.
- GET-writes scan: every `GET` under `src/app/api/tech` was checked; only `guide/route.ts` writes (via `getGuide`). The implementer re-runs the scan (`awk` over GET bodies for `insert|update|INSERT|UPDATE|Stamp`) and adds `write:false` handling for anything new.

- [ ] **Step 1: Write the failing tests**:
  - `falls back to the previewed technician`
  - `no fallback for an admin-tier target`
  - `no fallback for a forged cookie`
  - `no fallback for an expired cookie`
  - `no fallback for a cookie bound to another admin`
  - `no fallback when the admin is not a platform admin`
  - `getGuide with write:false never executes guideStampSql`
  - `previewGate refuses POST /api/tech/time`
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/tech-session.test.ts src/lib/tech/guide-queries.test.ts src/lib/auth/preview-gate.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. Screenshot `/tech/guide` at 390 with `--preview-as <technician id>` and look at it.
- [ ] **Step 5: Commit** — `feat(golive): view as a technician renders /tech read-only`.

### Task 20: Speed S3 — payload trims on list endpoints (after Tasks 10–13)

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (`listInvoices` select) and `src/lib/admin/queries.ts` (`getRequests` select).
- Then customers/estimates list selects, but only if their page-1 payload is over 30 KB.
- Contract tests go next to each module.

**Interfaces:**
- The list row types lose exactly the fields no list component reads. Find them by grepping `src/components/admin/invoices/*` and `src/app/admin/(dashboard)/requests/*`.
- `LIST_INVOICE_FIELDS` / `LIST_REQUEST_FIELDS` are exported constants.
- Detail endpoints are unchanged.

- [ ] **Step 1: Write the failing contract test:** `listInvoices row keys equal LIST_INVOICE_FIELDS and contain no fieldpulseData` (same for requests).
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/invoice-queries.test.ts src/lib/admin/queries.test.ts` → FAIL.
- [ ] **Step 3: Trim** the selects and types. tsc proves no list component used a dropped field.
- [ ] **Step 4: Run** → PASS. Compare `curl -s -o /dev/null -w '%{size_download}'` before/after (dev session), then re-run `measure-latency.mjs`.
- [ ] **Step 5: Commit** — `perf(speed): list endpoints return only rendered fields`.

### Task 21: Speed S4 — serial client fetch chains

**Files:** The page clients for Dashboard, Requests, Invoices, Customers and Dispatch, where a second fetch waits on the first without using its result. Known: invoices page → `/api/admin/payments/reconcile` is deferred until after first paint.

- [ ] **Step 1:** List the chains (each client's `useEffect`/SWR keys) in the task report.
- [ ] **Step 2:** Write a failing test per extracted decision (e.g. `reconcileShouldRun({ firstPaintDone:false }) === false`).
- [ ] **Step 3:** Parallelize or defer.
- [ ] **Step 4:** Tests PASS; `measure-latency.mjs` shows no regression.
- [ ] **Step 5:** Commit — `perf(speed): run independent admin fetches in parallel`.

### Task 22: Handover doc and runbook (always runs; documents what shipped)

**Files:** Create `docs/spears-handover.md`. Modify `.claude/skills/admin-pages/SKILL.md` (one pointer line).

**Content.** The SQL is exact, user-run, after hours, on prod. Agents never execute it. `O` below = `'00000000-0000-0000-0000-000000000001'`, written out in full in the doc.

1. **Now (owner):** deactivate `admin@demo-hvac.com` in Staff.
2. **Deploy.**
   - Run the gates.
   - `vercel login`, then `vercel deploy --prod --yes`.
   - `bash scripts/agent/prod-smoke.sh` — expect "demo login refused 401".
3. **Env (Vercel prod), then redeploy:**
   - `PLATFORM_ADMIN_EMAILS=rchen.workmail@gmail.com`
   - `PLATFORM_ORG_ID=00000000-0000-0000-0000-000000000001`
   - `RESEND_API_KEY` — confirm it is present.
   - `NEXT_PUBLIC_APP_URL=https://ai-hvac-agent-lovat.vercel.app`
   - `DEMO_MODE_ORG_IDS` — leave unset.
4. **P0 SQL:**
   - (1) `UPDATE users SET is_active=false, password_hash=NULL, google_id=NULL, updated_at=now() WHERE organization_id=O AND lower(email) LIKE '%@demo-hvac.com';`
   - (2) `UPDATE staff_invites SET revoked_at=now() WHERE organization_id=O AND accepted_at IS NULL AND revoked_at IS NULL AND invited_by_user_id IN (SELECT id FROM users WHERE organization_id=O AND lower(email) LIKE '%@demo-hvac.com');`
   - (3) Review queries:
     - `SELECT a.created_at, a.action, a.entity, a.entity_id, COALESCE(u.email, si.email) AS touched_email FROM audit_log a JOIN users d ON d.id=a.user_id LEFT JOIN users u ON u.id=a.entity_id LEFT JOIN staff_invites si ON si.id=a.entity_id WHERE a.organization_id=O AND lower(d.email) LIKE '%@demo-hvac.com' AND a.action IN ('create_staff','update_staff','reset_staff_password','create_technician','update_technician','create_invite') ORDER BY a.created_at;`
     - `SELECT i.email, i.accepted_at FROM staff_invites i JOIN users d ON d.id=i.invited_by_user_id WHERE i.organization_id=O AND lower(d.email) LIKE '%@demo-hvac.com' AND i.accepted_at IS NOT NULL;`
   - (4) For each user the owner does NOT confirm: `UPDATE users SET is_active=false, password_hash=NULL, google_id=NULL WHERE id='<id>' AND organization_id=O;`
   - (5) Widget keys: `SELECT id, key_prefix, key_type, created_at FROM widget_keys WHERE organization_id=O AND is_active AND revoked_at IS NULL;` → for each key the owner doesn't recognise: `UPDATE widget_keys SET is_active=false, revoked_at=now() WHERE id='<id>' AND organization_id=O;`
   - Columns verified: `audit_log` at `schema.ts:1111` (`entity_id` is a uuid); `widget_keys` (`key_prefix`, `key_type`, `is_active`, `revoked_at`).
5. **Rename:** `UPDATE organizations SET name='Spears Services', updated_at=now() WHERE id=O;`
6. **Marking.**
   - Dry run: `DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org <O>`. It prints both modes, the 60-day flag and the empty-mode dunning warning.
   - The owner picks a mode, then runs `… --mode <history|empty> --apply --prod`.
7. **Onboarding reset** (after marking; nobody opens the admin in between): `UPDATE organization_settings SET onboarding_state = (COALESCE(onboarding_state,'{}'::jsonb) - 'dismissed' - 'dismissedAt' - 'completedSeenAt' - 'firstCompleted' - 'flags' - 'embedViewed') || jsonb_build_object('firstSeenAt', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE organization_id=O;`
8. **Chick, one batch** — Chick becomes active, so View-as can target him next:
```sql
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM users WHERE organization_id='00000000-0000-0000-0000-000000000001' AND lower(email)='chick.s@spearsservices.com';
  IF n <> 1 THEN RAISE EXCEPTION 'chick row missing'; END IF;
  SELECT count(*) INTO n FROM organizations WHERE id='00000000-0000-0000-0000-000000000001' AND (owner_email IS NULL OR lower(owner_email)='chick.s@spearsservices.com');
  IF n <> 1 THEN RAISE EXCEPTION 'owner_email is set to someone else'; END IF;
  UPDATE users SET is_active=true, role='admin', password_hash=NULL, google_id=NULL, updated_at=now() WHERE organization_id='00000000-0000-0000-0000-000000000001' AND lower(email)='chick.s@spearsservices.com';
  UPDATE organizations SET owner_email='chick.s@spearsservices.com', updated_at=now() WHERE id='00000000-0000-0000-0000-000000000001';
END $$;
```
   Chick can't sign in yet: there is no password and no invite.
9. **Prod check:** rchen → Platform → View as Chick → walk the Task 18 page list → Exit. If Tasks 14–15 did not ship, drop this step; Chick's view gets checked with him after step 10.
10. **Invite:** Platform → "Send owner invite". It is emailed, or shows the copy link if Resend is missing.
11. **Switches later:** Platform → Switches. Before turning review requests on, run `SELECT count(*) FROM communication_jobs WHERE organization_id=O AND status='pending' AND trigger_type='review_request';` — those jobs send on the next drain (`job-queue.ts:120-135`).
12. **Verification:**
    - smoke is green;
    - the demo login is refused with 401;
    - Chick's view shows no completed pre-go-live work;
    - the AR tile equals the open-invoice total;
    - Map is absent;
    - the invite arrived;
    - Chick is `super_admin` after accepting.
13. **Rollback:**
    - Vercel instant rollback;
    - `golive-hide-history.mjs --unhide --prod`;
    - flags back through Switches;
    - 0059 is additive, so leave it.
    - Known gap (ruling 16): a hidden request reopened by status only stays hidden — use `showHistory` or `--unhide`.
14. **Dev notes:** `DEMO_MODE_ORG_IDS`; the speed tables (owner vs Chick); the S5 notes; rulings 1–16.

- [ ] **Step 1:** Draft the doc from `git log --oneline a4d5529..HEAD`. Drop or mark any step whose task did not ship.
- [ ] **Step 2:** Grep every column and table in the SQL against `src/lib/db/schema.ts`; fix mismatches.
- [ ] **Step 3:** `node scripts/agent/verify-skills.mjs` → 0 missing.
- [ ] **Step 4:** Commit `docs(golive): Spears handover — runbook, verification, rollback`.

---

## Self-review

- **Spec coverage:**
  - P0 → T1, T2, T22
  - P1 → T3, T4, T22
  - P2 → T5, T7, T22
  - P3 → T3, T5, T6, T22
  - P6 → T3, T8, T9, T10–T13
  - P7 → T14, T15, T19
  - P8 → T18
  - P5 → T2
  - S1 + S5a + S5 → T16; S2 → T17; S3 → T20; S4 → T21
  - Rollout → T22
  - Tenant export stays explicit-column (`export-queries.ts:77-82`).
- **Type consistency:**
  - `Visibility`, `visibleRows`, `visibleRowsSql`, `SHOW_ALL`, `VISIBLE_ONLY` (T8) → T10–T13.
  - `MutationActor`, `assertMayMutateUser`, `loadInviter`, technician result unions (T5) → T7.
  - `getFeatures`, `parseFeatures`, `featurePatchSchema`, `loadOrgRow` (T4) → T6 and T8.
  - `PreviewState` (T8) is filled in by T15.
  - `PREVIEW_COOKIE`, `verifyPreviewCookie`, `previewGate`, `previewProxyDecision` (T14) → T15 and T19.
  - `navGroupsFor(placement, { map })` (T6) → T16.
- **Proportion:** signatures, test names and assertions only. SQL appears verbatim only in the runbook, where the spec requires it.

## Review log

**Round 1** (adversarial). All items applied; none rejected.

1. **Execution.** It is now sequential by default. Explicit pairs (T1∥T3, T2∥T9, T7∥T8, T14∥T17) follow the pair rule. T16 runs alone; T17's re-measure is deferred.
2. **`buildNeedsActionCountQuery`** moved to Sweep A; Task 10 tests the needs-action count.
3. **Runbook.**
   - The Chick batch (8) now comes before View-as (9), and the invite (10) after.
   - The widget-key, invite-revoke and audit queries are scoped to the org.
   - The Chick batch clears `google_id`.
4. **Task 5.**
   - Technician result unions and the 403/404 mapping are defined.
   - Added the `updateStaff` role-change test.
   - Ruling 6 is narrowed, with the demoted-inviter case.
   - Promotion needs a platform-admin inviter (T7).
5. **Task 14.** `previewProxyDecision` and path-variant tests added; ruling 9 marked as a deviation.
6. **Task 19.**
   - `getGuide` `write:false` path.
   - Tech GET scan (only `guide` writes).
   - `isPlatformAdmin` required in the fallback.
   - Negative tests and the `/tech/:path*` matcher.
7. **Resumable sessions.**
   - Kept visible in both modes.
   - New triggers on `messages` and `appointments` INSERT, with integration tests.
   - The status-only reopen is documented as an accepted gap (ruling 16).
8. **Scanner.**
   - Added the `${T}` pattern.
   - Coverage is per table and per alias.
   - `whereClauseNoSource` counts are tested.
   - Module-level fragments are pre-listed.
   - Function-level entries replace prefixes outside tech/portal/integrations.
9. **Minors.**
   - `booked_assigned` joins requests.
   - `cancelled_at IS NULL`.
   - The migration idempotency test re-executes the statements.
   - The seed test is renamed.
   - The PATCH route checks the same-origin guard.
   - Invite cap semantics (≤ 19 prior).
   - The grep comment filter.
   - `conversation-reply-logic.test.ts`.
   - The mint scripts are fixed in T2.
   - File-map entries for the preview helpers.
   - `/admin/settings/forms/<id>` added to the walk.
   - Line numbers refreshed; the `calendar-time.ts` path corrected.

**Round 2.** All items applied.

1. **Task 10 → Task 11 ordering.** Task 10 passes `SHOW_ALL` + `TODO(Task 11)` at `conversation-queries.ts:305`; Task 11 swaps in `vis`, with a test and a grep check.
2. **Allowlist.** `golive-marking-sql.ts#*` added to `permanent.json`.
3. **Trigger re-sync.** The UPDATE triggers now carry `IS DISTINCT FROM` guards per table, so FieldPulse re-sync (which re-SETs the same values) doesn't un-hide history. Added integration tests for a same-value UPDATE and for re-running `upsertInvoiceRecord`.
4. **Task 14 ∥ 17.** Task 17's screenshots and dedicated skeletons run only after both pair members commit (Step 4b).
