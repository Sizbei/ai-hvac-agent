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

### Task 23: Deploy and test on production (controller-run; user-authorized 2026-11-10)

Runs only after Task 22, the final whole-branch review and its fix wave are committed, and full gates are green.

**Preconditions (all must hold; otherwise stop and report):**
- `vercel whoami` succeeds. The CLI token was expired on 2026-11-10; the user runs `! vercel login`.
- After hours for Spears (Eastern time, outside about 07:00–19:00) or explicit user go-ahead. Migration 0059 runs inside the build and writes prod: columns default false, and the flags are seeded off. It neither hides nor deletes data.
- The branch is merged to `main` and pushed (user-approved merge).
- Comms queue guard on prod reads 0.

**Steps:**
- [ ] Record the current prod deployment URL (rollback target: `vercel rollback <url>`).
- [ ] `vercel deploy --prod --yes`. Watch the build log for `0059_golive` applied once.
- [ ] `bash scripts/agent/prod-smoke.sh`, which includes the 401 for the retired demo email.
- [ ] `node scripts/agent/measure-latency.mjs --base <prod url>`. Add the prod column to the speed before/after table.
- [ ] Read-only prod checks as rchen:
  - the org reads "Spears Services";
  - the map is hidden;
  - the platform switches render;
  - View as Chick shows the empty account with the setup guide and checklist;
  - any write in preview is refused.
- [ ] The prod SQL in `docs/spears-handover.md` (marking script `--prod`, Chick's owner promotion) stays user-run. Never run it by an agent.
- [ ] Append the deploy URL, smoke output and latency table to `docs/spears-handover.md`. Commit `docs(golive): deploy record`.

---

## Wave 2 — Tasks 24–43 (user request 2026-11-10: "setup ready and polished, site faster, deploying")

Drafted by a planner agent against the code at `a6f18ee`; reconciled by the controller. **Binding overrides (these win over any wave-2 text below):**

1. **Onboarding spec v3 FINAL is the authority** (`docs/superpowers/specs/2026-11-10-first-run-onboarding-design.md`, `b9f36b8`). The draft was written against v2. Where they differ, v3 wins, in particular:
   - Task 24:
     - 0060 has no `SET lock_timeout`.
     - PATCH always returns `204`, with no no-op skip.
     - The `guide` payload is v3 D1's (`… payLinks, hasFieldPulse, historyHidden, historyContact`), read by a separate SELECT that degrades to `guide: null`.
     - `historyHidden = !viewer.showHidden`.
   - Task 25: uses `cardView({ data, error, slow, placement, demoFlags })` and v3's state table and copy. The X is hidden and "Up next" is `outline` while the welcome is due. It also builds the sidebar "Quick tour" link in both footers.
   - Task 26:
     - The section is mounted once in a stable place, with its position decided at mount.
     - It keeps local `stop`/`completed` state.
     - It uses `window.history.replaceState` (not `router.replace`).
     - The fallback applies on `guide: null` or a failed GET.
     - Finish removes `?lesson` and forces a refresh.
     - Back is ghost, Show me outline, Next primary, and the hero action is `outline` while the tour is above it.
   - Task 27: the strip reads `window.location` once on mount.
   - Task 28: pricebook label is "Add item".
   - Task 29 (D6): no dependency on Task 19. It adds `features` now, and Task 19 later adds `write`. If `getFeatures` throws, use `payLinks:false`.
2. **Task 31 rulings:**
   - The admin sign-in page keeps its "Create an account" link only when `NEXT_PUBLIC_SIGNUP_ENABLED` is not `"false"`. The handover tells the user to set it `false` on prod.
   - Root public metadata stays org-neutral.
   - The admin tab fallback becomes "Service console".
3. **Task 38:** `regions: ["iad1"]` only. Fluid compute is reported, never toggled. That is the user's call in the handover.
4. **Deploy tasks 40–42:**
   - They need the user to run `! npx neonctl auth` and `! vercel login`. If either is missing at that point, ledger it and continue with the next task.
   - A preview deploy is only ever made with `DATABASE_URL` overridden to the rehearsal branch, never with the inherited prod URL. If the override can't be verified, skip the preview deploy.
   - No agent writes to the prod DB or passes `--prod`.
5. **Order:** use the **controller execution order** below; it supersedes the drafted order at the end of this wave. The wave-1 pair rule applies, but in practice the controller runs one implementer at a time. Tasks 24–29 are **Must** (onboarding; they run before Task 18).
6. **Wave-2 critic round 1 (architect/opus: 1 blocker, 6 majors). Binding fixes:**
   - **Smoke never writes prod** (B1). Task 39 also changes `scripts/agent/prod-smoke.sh`:
     - `BASE` is required, with no prod default.
     - The `POST /api/session` and `/api/chat` probes run only with `SMOKE_WRITES=1`, and are refused when `BASE` is the prod alias or a `*.vercel.app` prod URL.
     - Tasks 23, 41 and 43 run without writes. `AGENTS.md` and the admin-pages skill get the new invocation.
   - **The migrator refuses prod outside the prod build** (M2). Task 39 adds a guard to `src/lib/db/migrate.ts`: if the URL host contains `ep-withered-hill` and `VERCEL_ENV !== "production"`, it exits 1. This comes with a test.
     - Task 40 pins `--parent` to the DEV branch by id, and refuses if the new branch's host is `ep-withered-hill`.
   - **Preview isolation is proven before any request** (M1). Task 41 deploys with build-time and runtime overrides: `-b DATABASE_URL=… -e DATABASE_URL=…`, plus `-e AUTH_SECRET=<fresh random>`. Confirm the flag names with `--help`.
     - Before it, set a canary on the rehearsal branch only: rename org `…0001` to "Rehearsal branch".
     - A GET of a public page that shows the org name must show the canary before anything else runs. No canary means stop, with no further requests.
     - Authenticated measurement on the preview uses a session minted with the overridden secret, or is skipped.
     - Task 42 deploys the old commit from a `git worktree` in the scratchpad, with the same overrides, after confirming that commit's `migrate.ts` has the `VERCEL_ENV` guard.
   - **No authenticated agent request on prod before the user's onboarding reset** (M3). An admin page load as rchen stamps onboarding and can grandfather-dismiss.
     - Task 38's "Before" measures prod **unauthenticated** only: the public chat page and the `/admin/login` TTFB.
     - Task 23's authenticated checks and latency run only via View as Chick (`write:false`). They run only after the user confirms runbook step 7 (onboarding reset) is done; otherwise they are skipped and ledgered.
   - **Watch output is pattern-only** (M4). `summarizeLogLines` keys are route patterns (`/admin/invite/[token]`, `/portal/[token]`, `[id]`). Add a test that no key contains a uuid or a token-like segment (more than 16 url-safe chars).
   - **Task 29 runs before Task 18** (M5), right after Task 28, with `getGuide(org, userId, { features })` only. Task 19 later adds `write`.
   - **Git checks apply only for `--env production`** (M6). Run them with `git status --porcelain --untracked-files=no`, so the user's untracked `.agents/` never fails the check.
   - **Minors:**
     - Task 25 also modifies `src/lib/admin/setup-card-view.ts` and `src/components/admin/sidebar.tsx` (the Quick tour link). This is safe because Task 6 runs earlier.
     - Task 37 also adds `customers/[id]/loading.tsx`.
     - Task 31's demo scan covers user-visible copy only, not codes or keys. With `NEXT_PUBLIC_SIGNUP_ENABLED=false`, the `/signup` page and `/api/auth/signup/*` return 404.
     - Test names and copy in Tasks 25 and 26 follow spec v3 (e.g. "Stop {n} of 5", the `buildLessons({ payLinks, hasFieldPulse, historyHidden })` signature, `historyContact`, `?replay=1`).
   - **Proportion:**
     - Tasks 33 and 34 drop to **Could** and run only if time remains after Task 23's preconditions are met.
     - Task 36 is **deferred to after go-live**. It is not in this run, because it would add a third one-way prod migration for a gain the draft calls "may be negligible".


These 20 tasks don't repeat any of Tasks 1–23. HEAD is `a6f18ee`, so Tasks 1–4 and 9 are done. Wherever I say "inferred", I worked it out from code and did not measure or run it. Every task follows the plan's Global Constraints: the gates, DEV only, `git add` by path, and the commit trailer.

**Facts the tasks rely on, checked this session:**
- The journal ends at `0059_golive`, so the onboarding migration is 0060 and any index migration would be 0061.
- `next.config.ts` has no `images` key. `cacheComponents` is off (`next.config.ts:5-6`). That rules out `unstable_instant`, which needs Cache Components (`node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md:78`).
- `lucide-react` is already in the default `optimizePackageImports` list (`.../optimizePackageImports.md:23`).
- The bundle analyzer is `npx next experimental-analyze --output`, which writes to `.next/diagnostics/analyze` (`.../package-bundling.md:78-96`, Next 16.1 or later; we have 16.2.6).
- The Neon HTTP connection cache is always on (`node_modules/@neondatabase/serverless/CHANGELOG.md:109`). So Neon connection reuse needs no work, and no task is planned for it.
- `migrate.ts:15-21` skips migrations when `VERCEL_ENV` isn't `production`. Its comment says preview deploys inherit the prod `DATABASE_URL`. That makes a preview deploy dangerous unless `DATABASE_URL` is overridden (Task 41).
- `vercel.json` has no `regions` key and nothing about Fluid compute.
- Sentry is optional: it only turns on when `SENTRY_DSN` is set (`next.config.ts:47`, `src/instrumentation.ts:23-29`).

---

## A. Setup ready and polished (Tasks 24–32)

### Task 24: Migration 0060, per-user guide state, guide API (onboarding D1 and D7)
- **Why:** The spec's D1 and D7 (`2026-11-10-first-run-onboarding-design.md:64-101,186-193`). Admin users have no per-user state today; the only precedent is the technicians' `users.field_guide_state` (`schema.ts:320`, inventory §5).
- **Files:**
  - Create: `drizzle/0060_admin_guide.sql`, `drizzle/meta/0060_snapshot.json`, `src/lib/db/migration-0060.test.ts`, `src/lib/admin/admin-guide-state.ts` (+test), `src/app/api/admin/guide/route.ts` (+test), `tests/integration/admin-guide-state.test.ts`.
  - Modify: `src/lib/db/schema.ts` (users, next to `:320`), `drizzle/meta/_journal.json`, `src/lib/admin/onboarding-steps.ts:46-53` (`OnboardingPayload`), `src/app/api/admin/onboarding/route.ts` (GET), `src/lib/admin/onboarding-store.ts` (`EMPTY_SNAPSHOT`), `vitest.config.ts`.
- **Interface:**
  - Types: `type LessonId = "requests"|"schedule"|"technicians"|"customers"|"paid"` and `LESSON_IDS`.
  - `parseAdminGuideState(raw: unknown): AdminGuideState` never throws.
  - `mergeGuidePatch(state, patch, nowIso): AdminGuideState | null` returns null when nothing changes.
  - `welcomeDue(role, state): boolean`.
  - `guidePatchSchema` is strict and needs at least one key.
  - The GET payload gains `guide: { welcomeDue, lastLesson, tourCompletedAt, readOnly, hasFieldPulse, historyHidden }`.
  - **Deviation to flag to the spec owner:** spec D3's `buildLessons` needs `hasFieldPulse` and `historyHidden`, but D1's payload shape doesn't include them, so I added them here.
  - `PATCH /api/admin/guide` answers `200 { guide }`, `400`, `401`, `403 PREVIEW_READ_ONLY` or cross-site, or `429`. It is not audited (D1).
- **Verify:**
  - Pure tests: `0060 sets lock_timeout then ADD COLUMN IF NOT EXISTS admin_guide_state jsonb (nullable, no default)`, `welcomeDismissedAt/tourStartedAt/tourCompletedAt are write-once`, `lesson sets tourStartedAt if absent`, `a no-op body skips the UPDATE`.
  - Integration test: `the PATCH cannot touch another user's or another org's row` and `a preview GET leaves admin_guide_state and onboarding_state unchanged`.
  - `npx drizzle-kit generate` reports "No schema changes".
- **After:** Task 15 (viewer preview target) and Task 13 (onboarding signals are visible-only). If Tasks 14–15 are cut, `readOnly` is always false (D7).
- **Tier:** Must. The spec says Must; it sits past cut line A only because it depends on Task 15.
- **Agent:** tdd-guide; database-reviewer reviews `0060` and the merge UPDATE.

### Task 25: Welcome row in the Getting-started card (D2)
- **Why:**
  - Spec D2 (`:103-120`).
  - `setup-card.tsx:78` renders nothing unless placement is `operations` (inventory §1), but D2 says the row still shows under `integrations`.
  - critic-ux-r2 M2–M4 (`critic-ux-r2.md:4-6`): two dismiss controls, two primary buttons, and no table of card states.
- **Files:** Create `src/lib/admin/welcome-view.ts` (+test). Modify `src/components/admin/onboarding/setup-card.tsx`.
- **Interface:**
  - `welcomeRowView({ guide, orgName, placement, cardState }): { show; title; line; primary: { label; href }; hideCardDismiss: boolean; upNextVariant: "outline" | "default" }`.
  - `hideCardDismiss` and `upNextVariant` resolve M3 and M4.
  - "Not now" PATCHes `dismissWelcome` and moves focus to the next focusable element or the `h1`. In preview it only updates memory.
- **Verify:**
  - Test names: `row shows when placement is integrations`, `"Continue the tour (3 of 5)" after lastLesson=customers`, `no-FieldPulse line drops the first sentence`, `historyHidden variant per r2 B1 if spec v3 adopts it`, `readOnly never PATCHes`.
  - Screenshot: `node scripts/agent/screenshot-page.mjs /admin 1440` and `… /admin 390`, then look at both.
- **After:** Task 24. It can pair with Task 26, because the files are disjoint and both only consume Task 24's types.
- **Tier:** Must. **Agent:** tdd-guide.

### Task 26: "Learn the basics" tour section on `/admin/setup` (D3 and D5)
- **Why:** Spec D3 and D5 (`:122-172`). No admin tour exists anywhere (inventory §3). Also critic r2 M5 (the phone back gesture loses the lesson) and N3.
- **Files:**
  - Create: `src/lib/admin/tour-lessons.ts` (+test), `src/lib/admin/tour-view.ts` (+test), `src/components/admin/setup/learn-the-basics.tsx`.
  - Modify: `src/components/admin/setup/setup-page-client.tsx` (mount it outside the data gate, add the D5 header link).
- **Interface:**
  - `buildLessons(features: Features, ctx: { hasFieldPulse: boolean; historyHidden: boolean }): readonly Lesson[]`.
  - `tourPosition(lessonParam: string | null, guide): { index: number; placement: "above" | "below" | "collapsed" }`.
  - Lesson changes call `router.replace("?lesson=…#learn")` (M5).
  - Each lesson change fires a PATCH `lesson`, and Finish fires `tourCompleted`. Both are fire-and-forget.
- **Verify:**
  - Tests: `payLinks off → no pay-link sentence`, `no lesson mentions map or review texts`, `customers + historyHidden appends the history note`, `invalid ?lesson falls back to requests`, `completed collapses to "You've seen the basics · Replay tour"`.
  - Run `npx vitest run src/lib/admin/tour-lessons.test.ts src/lib/admin/tour-view.test.ts`.
  - Screenshot `/admin/setup?lesson=requests#learn` at 1440 and 390.
- **After:** Task 24. It pairs with Task 25.
- **Tier:** Must. **Agent:** tdd-guide.

### Task 27: Back-to-tour strip on 5 pages (D4)
- **Why:** Spec D4 (`:160-167`). `BackToGuideBanner` is already mounted on staff, requests, settings and pricebook (`staff/page.tsx:136`, `requests/page.tsx:124`, …). The new strip must stay separate from it and not fetch onboarding.
- **Files:**
  - Create: `src/lib/admin/tour-strip.ts` (+test), `src/components/admin/setup/back-to-tour-strip.tsx` (built from `InfoBanner`).
  - Modify these pages under `src/app/admin/(dashboard)/`: `requests/page.tsx`, `calendar/page.tsx`, `staff/page.tsx`, `customers/page.tsx`, `invoices/page.tsx`.
- **Interface:** `parseTourParams(sp: URLSearchParams): { lesson: LessonId; n: number; href: string } | null`. It returns null unless `from=tour` is set and `lesson` is in `LESSON_IDS`.
- **Verify:**
  - Tests: `from=setup returns null`, `lesson=map returns null`, `href is /admin/setup?lesson=<id>#learn`, `n matches the lesson order`.
  - Screenshot each page with `?from=tour&lesson=<id>` at 390.
  - r2 N4 (the strip disappears on drill-in) is out of scope; note it in the report.
- **After:** Task 26, because the lesson ids and order must be final.
- **Tier:** Must. **Agent:** tdd-guide.

### Task 28: Day-one empty states with one primary action (D6)
- **Why:** These empty states have no next action today:
  - `request-table.tsx:164-170`;
  - pricebook is plain text, not `EmptyState` (`pricebook-table.tsx:80`);
  - invoices has text only (`invoices/page.tsx:471-483`);
  - estimates (`estimates/page.tsx:315-319`);
  - dispatch has text only (`dispatch/page.tsx:208-212`).
- **Files:**
  - Modify `request-table.tsx` (add an `onCreate?` prop), `requests/page.tsx`, `pricebook-table.tsx`, `pricebook/page.tsx`, `invoices/page.tsx`, `estimates/page.tsx`, `dispatch/page.tsx`.
  - Create `src/lib/admin/empty-state-actions.ts` (+test).
- **Interface:** `emptyActionFor(page, { hasActiveFilters }): { kind: "callback"; label } | { kind: "link"; label; href } | null`.
  - Labels follow D6 exactly: "New request", "Add price", "Open estimates", "New estimate", "Open staff".
  - Callbacks use the page's existing open callback, not `?new=1`, because `useOpenFromParam` only reads on mount.
- **Verify:**
  - Test: `filters active → null (the filter-clear action stays)`.
  - Screenshot every empty page in a throwaway DEV org from `createOrgCore`, minted with `MINT_ORG_ID`, and delete the org afterwards. `seed-org.mjs` won't work here because it needs at least 1 customer (`seed-org.mjs:84`).
- **After:** Task 27, because both touch `requests/page.tsx` and `invoices/page.tsx`.
- **Tier:** Must. **Agent:** tdd-guide.

### Task 29: Tech guide shows pay-link copy only when pay links are on (D8)
- **Why:**
  - `guide-steps.ts:67` tells technicians "A pay link lets the customer pay by phone… or tap Send pay link".
  - Prod starts with `payLinks:false` (`0059_golive.sql:20`), and the send is refused (`money-triggers.ts`, Task 4).
  - The tests pin the current strings (`guide-steps.test.ts:31,43`).
- **Files:** Modify `src/lib/tech/guide-steps.ts` (+test), `src/lib/tech/guide-queries.ts` (+test), `src/app/api/tech/guide/route.ts`.
- **Interface:** The step builder takes `features: Pick<Features, "payLinks">`, and `getGuide(org, userId, { write, features })` passes it through.
- **Verify:**
  - Tests: `payLinks off → collect_payment why = "Cash and checks are recorded on the spot."` and `how drops ", or tap Send pay link"`; `on → unchanged strings`.
  - Screenshot `/tech/guide` at 390.
- **After:** Task 19, which owns `getGuide(…, { write })`. If Task 19 is cut, run this after Task 18 and add only `features`.
- **Tier:** Must. **Agent:** tdd-guide.

### Task 30: Fill Spears' empty settings on DEV; give the user a key-names-only report for prod
- **Why:**
  - Checklist step 1 needs `business_info.phone` and `businessHours`, and step 2 needs `logo_url` (inventory §1, `onboarding-sql.ts:17-19`).
  - Settings live in `organization_settings` (`schema.ts:1159-1202`).
  - The Spears facts that are verified: name, address, Eastern time. Hours are unverified (`memory/spears-services-brand.md:17-20`). There is no logo file in the repo.
  - critic r2 M7 asks to say which steps will still be open.
- **Files:** Create `src/lib/admin/settings-prefill.ts` (+test) and `scripts/agent/prefill-org-settings.mjs`.
- **Interface:**
  - `prefillPatch(current, facts): { businessInfo?: Record<string, string>; companyName?: string; timezone?: string }` fills empty keys only. Existing values always win.
  - CLI: `--org <uuid> [--apply]`. It is a dry run by default. It always refuses `ep-withered-hill`, and there is no `--prod` flag at all.
  - `--report` prints which keys are empty, by name only.
- **Verify:**
  - Tests: `never overwrites a non-empty key`, `never sets businessHours or logoUrl` (unverified or no asset), `refuses the prod host`.
  - The dry run on DEV shows the keys it would fill.
  - The output includes a "Confirm with Chick" list (hours, logo, phone) for Task 22.
- **After:** Nothing it depends on. It runs before Task 18 so the walk sees a realistic checklist.
- **Tier:** Should. **Agent:** tdd-guide.

### Task 31: Copy sweep for demo or placeholder wording, tab titles and human error copy
- **Why:**
  - **Tab titles and descriptions:** The root metadata reads "HVAC Customer Service" / "AI-powered HVAC service request assistant" (`src/app/layout.tsx:23-26`). The sign-in tab reads "Admin - HVAC Dashboard" (`src/app/admin/layout.tsx:4`), although `ADMIN_TITLE_FALLBACK = "Service console"` (`admin-title.ts:5`).
  - **Placeholder:** Chick sees "Acme Heating & Cooling" in Settings (`branding-panel.tsx:112`).
  - **Signup link:** The sign-in page says "New to Spears? Create an account" → `/signup` (`login-form.tsx:57-62`). That could lead Chick's staff to create a separate org.
  - **Error copy:** Many hooks use "Failed to load X" (for example `use-invoices.ts:166`, `use-estimates.ts:140`, `use-pricebook.ts:175`). Raw `e.message` reaches the UI at `use-agenda.ts:57,83` and `communications/templates/page.tsx:117`.
- **Files:** Those files, plus a new `src/lib/admin/copy-canon.test.ts`.
- **Interface:** None. The guard test scans `src/hooks`, `src/components/admin` and `src/app/admin` for these patterns in string literals:
  - `/Failed to (load|fetch)/`;
  - `\bdemo\b`;
  - `Acme`;
  - `setError(` fed by `e.message` or `err.message`.
- **Decisions for the user (don't pick silently):**
  - Should the signup link stay on prod?
  - Should the root title, which shows on the public pages, become org-neutral or say "Spears Services"?
- **Out of scope:** 138 ASCII "Couldn't" strings in 68 files break the Unicode `’` rule, but they predate this work, so I'm only noting them.
- **Verify:** `npx vitest run src/lib/admin/copy-canon.test.ts` fails before the sweep and passes after.
- **After:** Task 28. **Tier:** Should. **Agent:** tdd-guide.

### Task 32: Automated 390 px audit of Chick's daily pages, then a fix wave
- **Why:**
  - Task 18 walks at 390 px by eye. This task checks it mechanically first, so Task 18 confirms problems instead of discovering them.
  - Known risks: the preview banner has to fit at 390 px, and the setup page relies on `sm:` breakpoints (`assumptions.md:121-127`); r2 N9 (the tap target for the X).
  - Inferred: no overflow has been measured yet.
- **Files:** Create `src/lib/admin/mobile-audit.ts` (+test) and `scripts/agent/mobile-audit.mjs`, which reuses the screenshot script's minting. Fixes go in whichever files the findings point to, one commit each.
- **Interface:**
  - `auditFindings(m: { scrollWidth; viewport; targets: { selector; w; h }[] }): Finding[]` flags overflow above 0 px, and interactive elements in `main` smaller than 44×44.
  - CLI: `node scripts/agent/mobile-audit.mjs [--preview-as <id>]`.
  - Pages: `/admin`, `/admin/requests`, `/admin/calendar`, `/admin/customers`, `/admin/customers/<id>`, `/admin/invoices`, `/admin/invoices/<id>`, `/admin/estimates`, `/admin/staff`, `/admin/conversations`, `/admin/setup?lesson=requests`.
- **Verify:** The pure tests pass. The script exits 0 with "0 findings" after the fixes, and the before and after outputs go into `<scratchpad>/mobile-audit-{before,after}.txt`.
- **After:** Tasks 25–28 and 31, before Task 18.
- **Tier:** Should. **Agent:** e2e-runner.

---

## B. Faster (Tasks 33–38)

**Measuring:** every task measures with `node scripts/agent/measure-latency.mjs --runs 5 --out <scratchpad>/latency-<task>-{before,after}.txt` against `npm run build && npm run start`. Runs as Chick add `--preview-as <dev chick id>` (Task 15). The Task 16 baseline is the reference.

### Task 33: Read the admin session once per server render
- **Why:**
  - `getAdminSession` has no React `cache` (`session.ts:31`).
  - One first load calls it up to three times: `generateMetadata` (`(dashboard)/layout.tsx:18`), the layout (`:29`), and pages such as `invoices/[id]/page.tsx:22`.
  - Each call verifies the JWT and may run the revocation SELECT. That cache is per instance and lasts 30 s (`session-revocation.ts:39-56`), so on a cold instance every call misses (inferred).
  - `loadBillingState` already uses `cache` (`layout.tsx:62`).
- **Files:** Modify `src/lib/auth/session.ts` (+test).
- **Interface:** None. `getAdminSession` keeps its signature. Route handlers are unaffected, because `cache` doesn't memoize outside a render.
- **Verify:**
  - Test: with a mocked `react.cache`, `two getAdminSession calls in one render run isSessionUserCurrent once`.
  - Measure the entry load of `/admin` and of `/admin/invoices/<id>`. If `measure-latency.mjs` only times clicks, add `--entry`.
  - Expectation: a small gain, a few ms in iad1 (inferred).
- **After:** Task 15 (`viewer.ts` consumes it). **Tier:** Could. **Agent:** tdd-guide.

### Task 34: Warm list data when the pointer or focus reaches a sidebar link
- **Why:**
  - In production, `<Link>` already prefetches the route shell automatically (`prefetching.md:34-57`, `sidebar.tsx:163`).
  - Data still waits for the page's client hook. That is the "client waterfall" in the speed spec (`speed-design.md:8-12`).
  - Fourteen hooks share `createSwrCache`, which has get/set but no in-flight dedupe (`swr-cache.ts:13-35`).
- **Files:** Modify `src/lib/admin/swr-cache.ts` (+test) to add `prime(key, loader)`. Modify `use-admin-requests.ts`, `use-invoices.ts`, `use-admin-customers.ts` and `use-estimates.ts` to export a page-1 primer. Modify `src/components/admin/sidebar.tsx` to call the primers on `onPointerEnter` / `onFocus`.
- **Interface:** `prime(key: string, loader: () => Promise<T>): void` does nothing if the key is fresh or already loading, and swallows errors.
- **Risk:** `adminRead` allows 60 requests per minute per user (`rate-limit.ts:94`), and Requests already polls every 10 s (`use-admin-requests.ts:37-38`). So it primes at most once per TTL, per key.
- **Verify:**
  - Tests: `prime does nothing on a fresh key`, `prime dedupes concurrent calls`, `a failed prime leaves the cache empty`.
  - Measure first-row p50 on Requests, Invoices and Customers, before and after.
  - Ship only if p50 improves by at least 50 ms locally; otherwise revert and report.
- **After:** Task 21, which reshapes the same hooks' fetch chains. **Tier:** Could. **Agent:** tdd-guide.

### Task 35: Client bundle and font weight, measured with the analyzer
- **Why:**
  - Nobody has measured the bundle yet.
  - The heavy dependencies are already loaded lazily: the map uses `next/dynamic` (`dispatch-map-provider.tsx:32-39`), and calendar drag-and-drop uses `dynamic` with `ssr:false` (`calendar/page.tsx:26-28`).
  - So the candidates are inferred:
    - the shared admin shell (global search, `@base-ui/react`);
    - IBM Plex Mono loading three static weights (`layout.tsx:16-21`), even though only 4 files pair mono with semibold.
- **Files:** Whatever the analyzer points to. The likely fixes are `next/dynamic` splits and `layout.tsx` font weights.
- **Interface:** None.
- **Verify:**
  - `npx next experimental-analyze --output`, then `cp -r .next/diagnostics/analyze <scratchpad>/analyze-before`, and the same again after.
  - Record the shared client JS and woff2 bytes on `/admin` from the Playwright network log.
  - Keep a change only if it saves at least 10 KB gz or removes a font file, and `measure-latency` frame and first-row values don't regress.
  - Dropping a font weight is a design call: check against `~/.claude/design-principles.md`.
- **After:** Task 21. **Tier:** Should. **Agent:** refactor-cleaner, with build-error-resolver if the build breaks.

### Task 36: Partial indexes for visible-only reads, only if EXPLAIN shows they help (migration 0061)
- **Why:**
  - Migration 0059 adds `hidden_from_org` but no index (`0059_golive.sql:7-15`).
  - After history marking, most rows on the five tables are hidden, and Chick's reads filter `= false`.
  - Precedent: `0042_perf_indexes.sql:2` says the tables have about 11k rows and a plain `CREATE INDEX` is fine.
  - Inferred: the gain may be negligible.
- **Files (only if justified):**
  - Create `drizzle/0061_visible_indexes.sql`, its snapshot, and `src/lib/db/migration-0061.test.ts`.
  - Modify `schema.ts` (`index(...).where(sql\`hidden_from_org = false\`)`, so drizzle-kit stays in sync) and `_journal.json`.
- **Interface:** None.
- **Verify:**
  - Render the visible-only `getRequests`, `listInvoices` and `getCustomers` SQL with `PgDialect`.
  - Run `EXPLAIN (ANALYZE, BUFFERS)` on DEV after Task 18's history marking, then measure as Chick before and after.
  - Ship only if a plan shows the filter removing more than 50% of rows and execution time drops.
  - Otherwise close the task with the EXPLAIN output in the report.
  - `drizzle-kit generate` reports "No schema changes".
- **After:** Task 18 (needs marked DEV data), Task 20 (final query shapes) and Task 24 (0060). **Tier:** Could. **Agent:** database-reviewer.

### Task 37: Loading and not-found follow-ups after Task 17
- **Why:**
  - A `loading.tsx` wraps its page and every child segment (`loading.md:78`). So `invoices/loading.tsx` also shows while `/admin/invoices/<id>` loads: the list skeleton for a detail page, which causes layout shift.
  - Task 17 Step 4b only checks `/admin`, calendar, estimates/<id> and customers/<id>.
  - `notFound()` is called at `settings/forms/[id]/page.tsx:12` and, after Task 6, by `/admin/map`, but `(dashboard)` has no `not-found.tsx`.
  - `error.tsx:21-37` hand-rolls a Card instead of using the `ErrorState` primitive.
- **Files:**
  - Create `(dashboard)/invoices/[id]/loading.tsx`, plus `settings/forms/[id]/loading.tsx` if its screenshot shifts.
  - Create `(dashboard)/not-found.tsx`: "We couldn’t find that page" with "Go to dashboard".
  - Modify `(dashboard)/error.tsx` to compose `ErrorState`, and extend `src/lib/admin/loading-coverage.test.ts`.
- **Interface:** None.
- **Verify:**
  - Test: `a detail [id] route never inherits a list-level loading.tsx`.
  - Screenshot `/admin/map` (switch off) and see the 404 inside the admin shell.
  - Measure the frame on `/admin/invoices/<id>` before and after; it should stay under 100 ms locally.
- **After:** Task 17. It can pair with Task 31 (disjoint files). **Tier:** Should. **Agent:** tdd-guide.

### Task 38: Pin the function region; Fluid compute is the user's call
- **Why:**
  - `vercel.json` has no `regions` key (`vercel.json:1-53`).
  - The speed spec's S5 only reports the compute mode (`speed-design.md:59-62`), and Task 16 records it.
  - Cold starts take 1.5–2 s (`speed-design.md:10`).
  - Neon is in us-east-1.
- **Files:** Modify `vercel.json` to add `"regions": ["iad1"]`. Add the Fluid setting only if the user approves it and Task 16's notes say it's off.
  - Check the `fluid` key's name and Hobby-plan limits in the current Vercel docs (context7) before editing.
- **Interface:** None.
- **Verify:**
  - Before: `measure-latency.mjs --base <prod url>` with a user-supplied `HVAC_SESSION`, against current prod. Record the first run after 15 minutes idle (cold) and the warm p50.
  - After: the same in Task 23.
  - `vercel.json` must still parse, and the crons must stay unchanged (12 entries).
- **After:** Task 35, and before Task 41 so the preview builds with it. **Tier:** Should. **Agent:** e2e-runner (measurement; the config edit is one line).

---

## C. Deploy (Tasks 39–43)

### Task 39: Pre-deploy checklist script that checks env var names only
- **Why:**
  - Task 23's preconditions are checked by hand (`plan:1186-1190`).
  - Handover step 3 needs these vars set: `PLATFORM_ADMIN_EMAILS`, `PLATFORM_ORG_ID`, `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL`, and `DEMO_MODE_ORG_IDS` must be unset (`plan:1122-1127`).
  - `REQUIRED_ENV_VARS` already exists but isn't exported (`env-validation.ts:23-148`).
- **Files:** Create `src/lib/deploy/env-check.ts` (+test) and `scripts/agent/predeploy-check.mjs`. Modify `src/lib/env-validation.ts` to export `requiredEnvNames()` and nothing else.
- **Interface:**
  - `parseVercelEnvLs(stdout: string): string[]`, tested against a fixture captured from a real `vercel env ls` run with the values column removed (inferred format).
  - `envCheck({ required, forbidden, present }): { missing: string[]; forbiddenPresent: string[] }`.
  - CLI: `node scripts/agent/predeploy-check.mjs [--env production|preview]`. It also checks that:
    - `vercel whoami` succeeds;
    - the git tree is clean and on `main`;
    - HEAD equals `origin/main`;
    - the newest `drizzle/*.sql` tag equals the last journal tag.
- **Safety:** It never calls `vercel env pull` and never prints a value.
- **Verify:**
  - Tests: `missing DEMO-free list passes`, `DEMO_MODE_ORG_IDS present fails`, `output contains no '='`.
  - The script exits 0 or 1 with a one-line reason per failure.
- **After:** Nothing. It can pair with Task 5. **Tier:** Must. **Agent:** tdd-guide.

### Task 40: Rehearse the migrations on a fresh Neon branch of DEV
- **Why:**
  - Prod will apply 0059, 0060 and maybe 0061 inside one build (`vercel.json:2`), and an instant rollback can't undo a migration (memory `migrations-not-run-on-deploy`).
  - DEV already has 0059, so the branch should come from a point in time before 0059 if Neon allows it (inferred). Check the flags with `npx neonctl branches create --help`.
- **Files:** None committed. Results go into the task report for Task 22.
- **Interface:** None.
- **Verify:**
  - The user runs `neonctl auth`.
  - The agent runs `npx neonctl branches create --parent <dev branch> [--parent-timestamp <pre-0059>] --name rehearse-golive`.
  - Then `DATABASE_URL=<branch url> npm run db:migrate`. Expect each new tag applied once and record the time per migration. Run it again and expect a no-op.
  - Run `VITEST_INTEGRATION=1` on `golive-unhide`, `admin-guide-state` and `onboarding-state` against the branch.
  - The branch URL lives only in an env var and is never echoed. The branch is deleted after Task 42.
- **After:** Task 36, so the set of migrations is final. **Tier:** Must. **Agent:** database-reviewer.

### Task 41: Preview deploy against the rehearsal branch, then smoke the preview URL
- **Why:**
  - Preview builds skip migrations (`migrate.ts:15-21`), and their comment says previews inherit the prod `DATABASE_URL`. A preview of this branch would then run new code against prod's un-migrated schema.
  - `prod-smoke.sh:6` already accepts `BASE`, but it has no checks for the new routes.
- **Files:**
  - Modify `scripts/agent/prod-smoke.sh`:
    - add an optional `BYPASS` header (`x-vercel-protection-bypass`, which the user supplies if deployment protection is on; inferred);
    - add unauthenticated `401` checks for `PATCH /api/admin/guide`, `GET /api/admin/preview` and `PATCH /api/platform/organizations/<uuid>`;
    - confirm every expected code against localhost first.
- **Interface:** `BASE=<preview url> BYPASS=<token> bash scripts/agent/prod-smoke.sh`.
- **Verify:**
  - `node scripts/agent/predeploy-check.mjs --env preview` passes.
  - Check `vercel deploy --help` for the runtime env flag, then run `vercel deploy --yes -e DATABASE_URL=<branch url>` without `--prod`.
  - Smoke passes, and `measure-latency.mjs --base <preview>` is recorded.
  - `bash -n scripts/agent/prod-smoke.sh` exits 0.
- **After:** Tasks 40 and 38, and the final whole-branch review. **Tier:** Should. **Agent:** e2e-runner.

### Task 42: Rollback rehearsal (old code on the new schema, and un-hide)
- **Why:**
  - The rollback plan relies on two claims (`plan:1167-1172`): that a Vercel instant rollback is safe, and that 0059 is additive so it stays. Neither has been tested.
  - `--unhide` has only run in integration tests (`plan:743`).
- **Files:** None committed. Results go to Task 22 for the handover's rollback section.
- **Interface:** None.
- **Verify:**
  - Get the current prod deployment's commit from `vercel inspect <prod url>` (read-only).
  - Deploy that commit as a preview pointed at the rehearsal branch, which has the new migrations. `prod-smoke.sh` must pass.
  - On the branch, run `npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --apply --mode history`, then `--unhide`. Row counts must match the pre-apply counts.
  - The branch host isn't `ep-withered-hill`, so no `--prod` is needed. Agents never pass it.
  - Record the exact `vercel rollback` syntax from `--help`, but never run it.
- **After:** Task 41. **Tier:** Should. **Agent:** e2e-runner.

### Task 43: Post-deploy watch script
- **Why:**
  - Task 23 stops after one smoke run (`plan:1195`).
  - Sentry is only on when `SENTRY_DSN` is set (`next.config.ts:47`, `instrumentation.ts:23-29`).
  - Logs carry codes and ids only (Global Constraints), so a summary can be printed safely.
- **Files:** Create `src/lib/deploy/log-scan.ts` (+test) and `scripts/agent/postdeploy-watch.sh`.
- **Interface:**
  - `summarizeLogLines(lines: string[]): { total; status5xx; byRoute: Record<string, number> }` prints counts only, never raw lines.
  - CLI: `bash scripts/agent/postdeploy-watch.sh <deployment url> [--minutes 60] [--every 10]`. It loops `prod-smoke.sh` and `vercel logs` (check the syntax with `vercel logs --help`; inferred).
  - If `SENTRY_DSN` is among the names from `vercel env ls production`, it prints "Check Sentry issues for release <sha>". It never calls the Sentry API.
- **Verify:** Tests: `counts 5xx by route`, `ignores 4xx`, `prints no line content`. `bash -n` exits 0.
- **After:** Build it any time after Task 39 (it can pair with Task 35). Run it after Task 23 for 60 minutes and append the summary to the deploy record.
- **Tier:** Should. **Agent:** tdd-guide.

---

7. **User authorization, 2026-11-10 (supersedes the prod restrictions above for the controller only).**
   - The user said: "yes we want it to touch live production. no one is using it yet". Production is not yet in real use.
   - **Who:** the controller, not implementer subagents, may:
     - deploy to prod without waiting for after-hours;
     - let migrations 0059/0060 run in the prod build;
     - run authenticated prod checks as rchen;
     - run the handover's prod steps itself. These are: the org rename and flags, the marking script with `--prod` (after a dry run, mode `history` unless the user says otherwise), the onboarding reset, and the platform env vars, set via `vercel env add` by name and with values the user supplies.
   - **Still requires an explicit user yes:**
     - sending Chick's owner invite email, because it reaches a third party;
     - any DELETE of prod rows;
     - `vercel rollback`;
     - pushing to or merging into `main`.
   - **Implementer subagents** remain DEV-only. Every guard from override 6 stays, as defence against accidents. Smoke writes stay opt-in (`SMOKE_WRITES=1`) because they leave a fake chat in the inbox. The controller may enable them once and then hide that session.

8. **User authorization, 2026-11-10: "deploying along the way is fine. try to do as much as possible without my approval".**
   - **No longer needs the user's approval:**
     - incremental prod deploys at checkpoints;
     - fast-forward merging this branch into `main` and pushing it (after full gates);
     - `vercel rollback` if a deploy breaks prod smoke;
     - setting the platform env vars the controller already knows (`PLATFORM_ADMIN_EMAILS` = the owner's sign-in email, `PLATFORM_ORG_ID` = `00000000-0000-0000-0000-000000000001`), by name via `vercel env add`.
   - **Still needs the user's approval:**
     - sending Chick's owner invite, because the user asked to send it themselves;
     - any DELETE of prod rows.
   - **Deploy checkpoints.** Each one runs the full gates, then ff-merges and pushes `main`, then `vercel deploy --prod --yes`. After that come smoke, View-as checks and a ledger record.
     - **D1** after Task 39: lockdown, migration 0059, switches and protection. Set the env vars first, then run the org rename to "Spears Services" and check that the flags were seeded off.
     - **D2** after Task 13: visibility filters. Then the marking script on prod: dry run, then `--prod --apply --mode history`, then the onboarding reset.
     - **D3** after Task 18: onboarding, polish and the P8 walk fixes.
     - **D4** is Task 23: the final deploy after the whole-branch review, then Task 43's watch.
   - If `vercel whoami` fails at a checkpoint, record it in the ledger, keep building, and retry at the next checkpoint.

### Controller execution order (supersedes the drafted order below)
1. Task 6.
2. Task 39 (now includes the smoke and migrator guards).
3. Task 30.
4. Task 7, then Task 8.
5. Tasks 10 → 11 → 12 → 13. *Cut line A.*
6. Task 16.
7. Task 14, then Task 17.
8. Task 15.
9. Task 24.
10. Task 25, then Task 26.
11. Task 27, then Task 28, then Task 29.
12. Task 31, then Task 37.
13. Task 32.
14. Task 18 (P8 walk). *Cut line B.*
15. Task 19.
16. Task 20, then Task 21.
17. Task 35, then Task 43 (build), then Task 38.
18. *If time remains:* Task 33, then Task 34.
19. **Final whole-branch review and one fix wave.**
20. Task 40, then Task 41, then Task 42 (each needs the user's `neonctl` / `vercel` login; skip and ledger if missing).
21. Task 22.
22. Task 39 run, then Task 23 (deploy and test), then Task 43 run (60 min).

Task 36 is deferred.

## Drafted execution order (superseded — kept for reference)

Each `∥` pair follows the plan's pair rule: disjoint files and no shared compile-time callers. Everything else runs one task at a time.

1. **Task 5 ∥ Task 39.** Task 39 only adds an export to `env-validation.ts`; Task 5 never touches it.
2. **Task 6 ∥ Task 30.** Task 30 creates only new files and writes DEV data.
3. **Task 7 ∥ Task 8**, as planned.
4. **Tasks 10 → 11 → 12 → 13.** *Cut line A.*
5. **Task 16**, alone (baseline).
6. **Task 14 ∥ Task 17**, as planned.
7. **Task 15**, then **Task 33** (`session.ts`, measured against Task 16).
8. **Task 24** (0060 and the API).
9. **Task 25 ∥ Task 26.** Card files and setup-page files are disjoint.
10. **Task 27**, then **Task 28** (both touch `requests/page.tsx` and `invoices/page.tsx`).
11. **Task 31 ∥ Task 37.** Hooks, login, metadata and branding panel on one side; new `loading`/`not-found` files and `error.tsx` on the other.
12. **Task 32** (mobile audit and fixes).
13. **Task 18** (walk; the dev mirror includes the Task 30 settings). *Cut line B.*
14. **Task 19 → Task 29.**
15. **Task 20 → Task 21.**
16. **Task 36** (needs Task 18's marked DEV data).
17. **Task 34**, then **Task 35 ∥ Task 43 (build)**, then **Task 38**.
18. **Final whole-branch review and fix wave**, then **Task 40 → Task 41 → Task 42**.
19. **Task 22.** It adds the Task 30 confirm list, the Task 40 and 42 rehearsal results, Task 43 usage, and the three onboarding rollout lines (spec `:224-232`).
20. **Task 39 run** (a Task 23 precondition), then **Task 23**, then **Task 43 run** (60 minutes).

**File conflicts to note:**
- `vitest.config.ts` is append-only and touched by Tasks 24 and 36.
- `scripts/agent/measure-latency.mjs` is touched by Tasks 16 and 15, and by 33 if it adds `--entry`.
- `setup-card.tsx` is touched only by Task 25; `onboarding/route.ts` by Tasks 15 and then 24.
- The hooks are touched in sequence by Tasks 31, 21 and 34.
- `sidebar.tsx` is touched by Tasks 6 and 34.
- `vercel.json` is touched only by Task 38.

**Open questions before building:**
- **Task 31:** should the "New to Spears? Create an account" link stay on prod, and what should the root/public tab title say?
- **Task 38:** is enabling Fluid compute OK?
- **Tasks 25–26:** onboarding spec v2 is still under review. Should critic-ux-r2 B1/M1 (the history-hidden copy and the "kept safe" wording) change the exact copy before these tasks start?
- **Task 24:** I added `hasFieldPulse` and `historyHidden` to the onboarding payload, which spec D1's shape doesn't include. This needs the spec owner's OK.

**Where evidence is inferred:**
- The gain from Task 33.
- The bundle candidates in Task 35.
- Whether the index in Task 36 helps at all; it's gated on EXPLAIN output.
- The `vercel env ls`, `vercel logs` and `vercel deploy -e` output formats and flags; each task checks `--help` first.
- Whether deployment protection is on for previews.
- Neon's point-in-time branching flag.

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
