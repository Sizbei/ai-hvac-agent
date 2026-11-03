# Setup Guide (auto-completing onboarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six-step home checklist with a Setup guide (page `/admin/setup`, home card, sidebar digit, back-to-guide banners) whose four required and four optional steps complete on their own from the org's real data, with deep links that open the exact dialog and a finishing moment.

**Architecture:** One FROM-less `SELECT` of scalar subqueries derives every step; a pure module (`onboarding-steps.ts`) turns signals + stored state into steps/progress/up-next/needs-attention; two idempotent jsonb upserts (`onboarding-sql.ts`) write first-completion stamps and flags (old values win; JS never read-modify-writes); a module-level client store feeds the card, the sidebar digit and the page from one request; nav placement is decided server-side in the existing layout query. A data-only migration (0051) adds the new state keys additively and backfills `company_name`.

**Tech Stack:** Next.js 16 App Router (`params`/`searchParams` are Promises; read `node_modules/next/dist/docs/` before touching pages), Drizzle 0.45 on Neon (neon-http: `db.batch()` only for statements fixed up front; `db.execute(sql…)` returns `.rows`), zod 4, vitest pure-helper tests (no jsdom; mocked `db`; SQL rendered with `new PgDialect().sqlToQuery`), admin design primitives in `src/components/admin/ui/*`, copy canon from `.claude/skills/admin-pages/SKILL.md`.

**Spec:** `docs/superpowers/specs/2026-11-04-onboarding-tutorial.md` (v4 FINAL; §3 step table, §4 behaviour, §6 statements, §7 API, §8 UI, §9 acceptance) and its review log. The spec is the authority; this plan is its argument.

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0; `npx eslint <changed files>` → 0 errors; `npx vitest run` never below the live baseline (4782 passed / 1 skipped at bbe0bcf; tests removed with replaced code are reported as a delta). No jsdom/RTL — component logic is extracted into pure helpers and tested there. `node scripts/agent/verify-skills.mjs` → 0 missing when skills change.
- Tenancy: every subquery (nested ones included) carries `organization_id = $org`; every admin route uses `getAdminSession()`; `adminRead`/`adminMutation` rate limits via `slidingWindow(RATE_LIMITS.…)`; request bodies via `readJsonBody`; envelopes via `successResponse`/`errorResponse`; audit `details` = `JSON.stringify({ keys })` field names only; never `err.message` in responses.
- Demo org = `organizationId === DEMO_ORG_ID` (`src/lib/tenancy/organization.ts:28`) on BOTH the admin and technician paths: no stamp, no PATCH write, no flag write, no audit; everything derived; `tech_sign_in` derives as done.
- Statements exactly as spec §6 (old wins: `$top || OLD`, `$new || OLD->'firstCompleted'`, `$flags || OLD->'flags'`; `OLD` = `CASE WHEN jsonb_typeof(onboarding_state)='object' THEN onboarding_state ELSE '{}'::jsonb END`; `?&` guards with `$keys` AND `$topKeys`; jsonb params as `JSON.stringify` text cast `::jsonb`; arrays via `sql.param([...])::text[]`). The GET is at most two round trips: the SELECT, then the stamp statement iff `$keys` or `$top` is non-empty. The response is built from the SELECT copy merged in memory, never from `RETURNING`.
- Background work via `after()` from `next/server` (never a detached promise), wrapped in try/catch that only logs.
- Hand-authored migration recipe: `drizzle/0051_onboarding_state_v2.sql` with `--> statement-breakpoint`, `_journal.json` entry (idx 51, tag `0051_onboarding_state_v2`, `when` later than 0050's), `drizzle/meta/0051_snapshot.json` = copy of 0050's with new `id` and `prevId` = 0050's `id` (precedent `0044_last_admin_guard`); `npx drizzle-kit generate` → "No schema changes"; `npm run db:migrate` twice on dev (`.env.local` = DEV branch; never prod `ep-withered-hill`).
- Dev data hazard: never create throwaway requests through `POST /api/admin/requests` on dev (the org is FieldPulse-connected and pushes real jobs); SQL rows only, deleted afterwards. Probe sessions: `TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs)` → cookie `hvac_admin_session`; dev server on `http://localhost:3000`; DB probes via a temporary `probe.mts` at the repo root (`config({ path: ".env.local" })`, neon client), deleted before committing.
- Copy canon: sentence case, "request", "technician", "sign in", Unicode …, no exclamation marks, errors "Couldn't … Please try again."; step strings EXACTLY as spec §3/§4 (titles, why lines, notes, button labels, finished wins).
- UI: compose `src/components/admin/ui/*` (`PageShell`, `PageHeader`, `SectionCard`, `ProgressBar`, `EmptyState`, `ErrorState`, `InfoBanner`, `ContextBadge`, `IconChip`); motion via repo tokens (`--dur-enter` 180 ms, transitions only, no stagger); read `~/.claude/design-principles.md` before any UI task; screenshots via `node scripts/agent/screenshot-page.mjs <path> <width> <out>` and LOOK at them.
- Order: Tasks 1 → 2 → 3 → 4 → (5 ∥ 6) → 7. Tasks 5 and 6 touch disjoint files and may run concurrently.

## Review Focus

1. A fresh provisioned org shows "0 of 4" with Up next "Add your business phone and hours"; `job_types` seeding and the owner's admin invite change nothing. (Task 2 pure tests; Task 7 probe.)
2. The stamp statement is sent iff `$keys` or `$top` is non-empty; a `dismissedAt`-only grandfather write with empty `$keys` lands; two concurrent GETs stamping different steps both land; a row-less org is created. (Task 1 render tests; Task 7 integration suite.)
3. `add_technician` and `book_first_request` re-open ("Needs attention") after `completedSeenAt` and show digit 1; after `dismissedAt` the digit never shows; the home card never returns. (Task 2 tests; Task 4 digit tests.)
4. `/admin/staff?new=technician&from=setup` opens the Add staff form on first visit, strips the params, and does not reopen on refresh; `useUrlFilterSync` pages still restore their filters. (Task 6 hook tests + probe.)
5. Another org's data never affects the steps and B's state is byte-identical after A's GET and PATCH. (Task 1 render test asserts one org param per subquery; Task 7 integration suite.)

---

## File map

| file | responsibility |
| --- | --- |
| `src/lib/db/schema.ts` (`onboardingState` `$type`, ~1213) | widened state type |
| `drizzle/0051_onboarding_state_v2.sql` + journal + snapshot | additive legacy-key rewrite + `company_name` backfill |
| `src/lib/admin/provisioning.ts` (~227) | seed `companyName: left(name,120)` |
| `scripts/agent/seed-org.mjs` (~247) | write the new state keys |
| `src/lib/admin/onboarding-state.ts` (+test) | `StepId`, `OnboardingState` zod parse (per-field catch, legacy fold), `Signals` type |
| `src/lib/admin/onboarding-sql.ts` (+test) | pure builders: `onboardingSelectSql`, `stampStatementSql`, `flagsStatementSql`, `techSignedInStatementSql` |
| `src/lib/admin/onboarding-steps.ts` (+test) | `STEP_DEFS`, `deriveSteps`, `grandfatherDecision`, `upNext`, `progressOf` |
| `src/lib/admin/onboarding-queries.ts` (+test, rewritten) | `getOnboarding(org, { demo, googleEnabled, appUrl })`, `patchOnboarding(org, body, { demo })` |
| `src/app/api/admin/onboarding/route.ts` (+test) | GET/PATCH |
| `src/lib/auth/tech-session.ts` | `techSignedInAt` hook |
| `src/components/admin/settings/embed-panel.tsx` | revealed-key copy → PATCH `flags.embedCopied` |
| `src/lib/admin/onboarding-store.ts` (+test for pure parts) | client store |
| `src/lib/admin/setup-digit.ts` (+test) | digit label/visibility/sr |
| `src/components/admin/nav-items.ts` (+test), `sidebar.tsx`, `dashboard-shell.tsx`, `global-search.tsx`, `src/app/admin/(dashboard)/layout.tsx` | `navGroupsFor(placement)`, server placement, setup badge |
| `src/components/admin/ui/section-card.tsx` (`meta`), `src/components/admin/ui/step-glyph.tsx` | primitives |
| `src/app/admin/(dashboard)/setup/page.tsx`, `src/components/admin/setup/*` | the guide page |
| `src/components/admin/onboarding/onboarding-checklist.tsx` → `setup-card.tsx`, `src/app/admin/(dashboard)/page.tsx` | home card |
| `src/hooks/use-open-from-param.ts` (+ pure parser test), `src/components/admin/setup/back-to-guide-banner.tsx` | deep links + banner |
| `src/app/admin/(dashboard)/{staff,pricebook,requests,settings}/page.tsx`, `src/components/admin/request-create-dialog.tsx`, `staff-form-dialog.tsx` | wiring |
| `tests/integration/onboarding-state.test.ts`, `vitest.config.ts` | integration suite |
| `.claude/skills/page-setup/SKILL.md` (new) + `page-dashboard`, `page-settings`, `page-staff`, `page-requests`, `page-pricebook`, `page-tech` | docs |

---

### Task 1: State type, SQL builders, migration 0051, provisioning seed

**Files:** `src/lib/db/schema.ts` (~1213), `src/lib/admin/onboarding-state.ts` (+ `.test.ts`), `src/lib/admin/onboarding-sql.ts` (+ `.test.ts`), `drizzle/0051_onboarding_state_v2.sql` + `drizzle/meta/_journal.json` + `drizzle/meta/0051_snapshot.json`, `src/lib/admin/provisioning.ts` (~227), `scripts/agent/seed-org.mjs` (~247).

**Interfaces (produced):**
```ts
// onboarding-state.ts
export const STEP_IDS = ["phone_hours","brand","add_technician","pricebook","book_first_request","tech_sign_in","chat_widget","integrations"] as const;
export type StepId = (typeof STEP_IDS)[number];
export interface OnboardingState { dismissedAt?: string; completedSeenAt?: string; firstCompleted: Partial<Record<StepId,string>>; flags: { embedCopied?: boolean; techSignedInAt?: string } }
export function parseOnboardingState(raw: unknown): OnboardingState   // zod, every field .catch(undefined); legacy dismissed:true → dismissedAt ?? "legacy"; embedViewed:true → flags.embedCopied; dates kept when Date.parse succeeds
export interface Signals { companyName: string|null; phone: boolean; businessHours: boolean; logoUrl: boolean; technicianReady: boolean; fpPasswordless: number; pendingInvite: boolean; pricebook: boolean; anyRequest: boolean; bookedAssigned: boolean; techSignedIn: boolean; widgetKey: boolean; allowedOrigins: boolean; integrationConnected: boolean; completedRequest: boolean; orgCreatedAt: string|null; state: OnboardingState }
// onboarding-sql.ts (pure, return SQL)
export function onboardingSelectSql(organizationId: string): SQL          // FROM-less SELECT, one column per Signals field (+ onboarding_state raw)
export function stampStatementSql(p: { organizationId: string; newStamps: Partial<Record<StepId,string>>; top: { dismissedAt?: string; completedSeenAt?: string } }): SQL
export function flagsStatementSql(p: { organizationId: string; flags: { embedCopied?: true; techSignedInAt?: string }; top: { dismissedAt?: string; completedSeenAt?: string }; guardTechSignedIn?: boolean }): SQL
```
`onboardingSelectSql` columns (each its own org-scoped subquery; `::request_status` casts where a status literal appears; the spec's exact predicates): `company_name`, `phone` (`business_info->>'phone' <> ''`), `business_hours`, `logo_url IS NOT NULL`, `technician_ready` (`EXISTS users … role='technician' AND is_active AND (password_hash IS NOT NULL OR google_id IS NOT NULL)`), `fp_passwordless` (`(SELECT count(*) …)::int`), `pending_invite` (`EXISTS staff_invites … role='technician' AND revoked_at IS NULL AND expires_at > now()`), `pricebook`, `any_request`, `booked_assigned` (spec §3 rule incl. the `assigned_to` branch), `tech_signed_in_evidence` (`EXISTS technician_time_entries … OR EXISTS technician_locations … OR EXISTS users … google_id IS NOT NULL AND role='technician' AND is_active`), `widget_key`, `allowed_origins` (`jsonb_array_length(allowed_origins) > 0`), `integration_connected` (three `connected = true` EXISTS), `completed_request` (`EXISTS service_requests … status='completed'::request_status`), `org_created_at`, `onboarding_state`.

- [ ] **Step 1: Failing tests.** `onboarding-state.test.ts`: legacy `{dismissed:true,embedViewed:true}` → `dismissedAt` set + `flags.embedCopied`; `{dismissed:false}` → no `dismissedAt`; a malformed `firstCompleted` (array) drops only that field; top-level `null`/string → empty state; valid v2 round-trips. `onboarding-sql.test.ts` (render with `PgDialect`): the SELECT has no `FROM` at top level, contains `organization_id = $n` once per subquery (count the parameter occurrences = number of subqueries), uses `jsonb_array_length`, `::request_status`; `stampStatementSql` renders `INSERT INTO organization_settings … ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(` with `$top || CASE WHEN jsonb_typeof(` and `WHERE NOT (… ?& $n::text[]) OR NOT (… ?& $n::text[])`, params include the JSON strings and two text arrays; empty `newStamps` with a `top` still renders (grandfather-only); `flagsStatementSql` with `guardTechSignedIn` appends `WHERE … #> '{flags,techSignedInAt}' IS NULL` and without it has no WHERE; both end with `RETURNING onboarding_state`.
- [ ] **Step 2: Implement** the three modules. Widen the schema `$type` to the v4 shape (legacy keys optional).
- [ ] **Step 3: Migration 0051** exactly as spec §6 (two statements, breakpoint), journal + snapshot copy; `npx drizzle-kit generate` → "No schema changes"; `npm run db:migrate` twice; probe: a settings row seeded by SQL with `{dismissed:true,embedViewed:true}` gains `dismissedAt` (ISO `…Z`) and `flags.embedCopied` and keeps the legacy keys; re-running the UPDATE changes 0 rows; a settings row with NULL `company_name` is backfilled from `organizations.name`. Delete probe rows.
- [ ] **Step 4: Provisioning** `.values({ organizationId, companyName: name.slice(0, 120) })` at `provisioning.ts` ~227 (`name` is in scope); `seed-org.mjs` writes `{ dismissedAt, flags: { embedCopied: true } }`.
- [ ] **Step 5: Gates + commit** `feat(onboarding): state type, SQL builders, additive migration 0051, company name seeded at provisioning`.

---

### Task 2: Pure derivation + query module

**Files:** `src/lib/admin/onboarding-steps.ts` (+test), `src/lib/admin/onboarding-queries.ts` (rewrite, +test rewrite).

**Interfaces (produced):**
```ts
// onboarding-steps.ts (pure)
export interface StepDef { id: StepId; phase: 1|2|3; title: string; why: string; estimateMinutes: number|null; estimateLabel: string; required: boolean; live: boolean; href: string|null; hrefLabel: string; secondaryHref?: string; secondaryLabel?: string }
export const STEP_DEFS: readonly StepDef[]   // spec §3 strings verbatim, in order
export interface DerivedStep extends Omit<StepDef,"live"> { done: boolean; needsAttention: boolean; stamped: boolean; note?: string; action?: "copy_sign_in_link"; copyValue?: string; instruction?: string }
export interface Derived { steps: DerivedStep[]; progress: { requiredDone: number; requiredTotal: 4; optionalDone: number; optionalTotal: 4 }; upNext: StepId|null; newStamps: Partial<Record<StepId,string>> }
export function deriveSteps(s: Signals, opts: { now: Date; demo: boolean; googleEnabled: boolean; appUrl: string }): Derived
export function grandfatherDecision(s: Signals, d: Derived, now: Date): { dismissedAt?: string; completedSeenAt?: string }   // only when state has no stamps and not demo
export function upNext(steps: readonly DerivedStep[]): StepId|null
// onboarding-queries.ts
export interface OnboardingPayload { steps: DerivedStep[]; progress: Derived["progress"]; upNext: StepId|null; dismissedAt: string|null; completedSeenAt: string|null }
export async function getOnboarding(organizationId: string, opts: { demo: boolean; googleEnabled: boolean; appUrl: string; now?: Date }): Promise<OnboardingPayload>
export async function patchOnboarding(organizationId: string, body: { dismissed?: true; completedSeen?: true; flags?: { embedCopied?: true } }, opts: { demo: boolean }): Promise<OnboardingState>
```
Rules (spec §4 verbatim): `done = live ? rule : (rule || stamped)`; `needsAttention = live && stamped && !rule`; `add_technician` rule = `technicianReady`; `book_first_request` rule = `bookedAssigned`; `tech_sign_in` rule = `flags.techSignedInAt || techSignedIn || demo`; notes per §3 (phone-only, pending invite, FieldPulse count with/without Google, pick a time); `add_technician.href` switches to `/admin/staff?from=setup` + "Set a password in Staff" when `fpPasswordless > 0`; `tech_sign_in` gets `action`, `copyValue = appUrl.replace(/\/+$/, "") + "/tech-login"`, `instruction` (+ Google clause iff `googleEnabled`); `newStamps` = done steps without a stamp (ISO `now`); `upNext` = first not-done required, else first not-done optional. `grandfatherDecision`: no stamps yet (`firstCompleted` empty) and not demo: all required done → `completedSeenAt`; else `orgCreatedAt` older than 14 days AND `completedRequest` → `dismissedAt`. `getOnboarding`: `db.execute(onboardingSelectSql)` → map row → `parseOnboardingState` → derive → if not demo and (`newStamps` or `top` non-empty) → `db.execute(stampStatementSql)` → payload from the in-memory merge (`firstCompleted` ∪ `newStamps`, `top` applied only where unset). `patchOnboarding`: demo → return the merged state without writing; else `db.execute(flagsStatementSql({ flags, top: { dismissedAt?, completedSeenAt? } }))` and parse `RETURNING`.

- [ ] **Step 1: Failing tests** (pure): fresh signals → 0 of 4, upNext `phone_hours`, digit inputs; each note; the FieldPulse href switch; `tech_sign_in` copy value + instruction with/without Google; demo → `tech_sign_in` done; stamps: a done step without a stamp appears in `newStamps`; sticky: `pricebook` stamped + rule false → done; live: `add_technician` stamped + rule false → `needsAttention`, not done; `upNext` ordering incl. optional fallback and none; `grandfatherDecision` three branches + "has stamps → nothing" + demo → nothing. Query tests (mock `db.execute` queue): GET sends one statement when nothing to stamp, two when stamps/top needed, one for demo even with stamps; PATCH demo → no execute; PATCH builds the flags statement with `top`.
- [ ] **Step 2: Implement**; delete the old `getOnboardingState`/`updateOnboardingFlags` (route is rewritten in Task 3; until then keep a thin alias so tsc passes, removed in Task 3).
- [ ] **Step 3: Gates + commit** `feat(onboarding): derive steps, progress, grandfathering; query module on the new statements`.

---

### Task 3: Routes, technician sign-in hook, embed copy flag

**Files:** `src/app/api/admin/onboarding/route.ts` (+ `route.test.ts`), `src/lib/auth/tech-session.ts`, `src/components/admin/settings/embed-panel.tsx`, remove the Task 2 alias.

- GET: session → `adminRead` limit → `getOnboarding(org, { demo: org === DEMO_ORG_ID, googleEnabled: <the same check `/tech-login` uses for Google, grep `googleEnabled` in `src/app/tech-login/page.tsx`>, appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "" })` → `successResponse(payload)` (no wrapper). PATCH: `readJsonBody` → `z.strictObject({ dismissed: z.literal(true).optional(), completedSeen: z.literal(true).optional(), flags: z.strictObject({ embedCopied: z.literal(true).optional() }).optional() })` refined "at least one leaf true" → `adminMutation` → `patchOnboarding` → audit `onboarding_updated` `JSON.stringify({ keys })` (skip audit for demo) → `successResponse(state)`.
- Hook: in `createTechSession` after the cookie is set, `after(async () => { try { if (payload.organizationId === DEMO_ORG_ID) return; await db.execute(flagsStatementSql({ organizationId: payload.organizationId, flags: { techSignedInAt: new Date().toISOString() }, top: {}, guardTechSignedIn: true })); } catch (e) { logger.warn(…) } })`. Pure test of the statement exists from Task 1; add a unit test that `createTechSession` for the demo org never calls `db.execute` (mock `after` to run immediately, mock `cookies`).
- Embed panel: the `CopyButton` beside the REVEALED key (`embed-panel.tsx` ~161) gets an `onCopied` that PATCHes `{ flags: { embedCopied: true } }` (fire-and-forget, errors ignored) and calls `onboardingStore.invalidate()` if the store exists (Task 4 adds it; use a dynamic import or wire in Task 6 — ruling: do the PATCH here, add the store call in Task 6); the placeholder snippet copy (~134) does not.
- Route tests: 401 without session; GET 200 shape (mock `getOnboarding`); PATCH 400 on `{}`/`{dismissed:false}`/`{flags:{techSignedInAt:"x"}}`/extra keys; 200 with audit keys `["dismissed"]`; demo → no audit.
- [ ] Steps: failing route tests → implement → gates → commit `feat(onboarding): routes on the new payload, technician sign-in flag, embed copy flag`.

---

### Task 4: Client store, sidebar digit, server nav placement, primitives

**Files:** `src/lib/admin/onboarding-store.ts` (+ `onboarding-store.test.ts` for the pure parts), `src/lib/admin/setup-digit.ts` (+test), `src/components/admin/nav-items.ts` (+ `nav-items.test.ts`), `src/components/admin/sidebar.tsx`, `src/components/admin/dashboard-shell.tsx`, `src/components/admin/global-search.tsx`, `src/app/admin/(dashboard)/layout.tsx`, `src/components/admin/ui/section-card.tsx`, `src/components/admin/ui/step-glyph.tsx`.

**Interfaces (produced):**
```ts
// onboarding-store.ts
export function getOnboardingSnapshot(): { data: OnboardingPayload|null; error: boolean; loadedAt: number|null }
export function subscribeOnboarding(cb: () => void): () => void
export function refreshOnboarding(opts?: { force?: boolean }): Promise<void>   // no-op while in flight or data younger than 1 s unless force
export function invalidateOnboarding(): void
export function useOnboarding(): { data, error, refresh }                       // useSyncExternalStore; mounts a single visibilitychange listener (10 s rule)
export function shouldRefresh(now: number, loadedAt: number|null, inFlight: boolean, force: boolean): boolean   // pure, tested
// setup-digit.ts (pure)
export function setupDigit(p: { data: OnboardingPayload|null }): { visible: boolean; label: string; srLabel: string }   // spec §2 rules incl. needsAttention after completedSeenAt, never after dismissedAt, singular/plural
// nav-items.ts
export type SetupPlacement = "operations" | "integrations";
export function navGroupsFor(placement: SetupPlacement): readonly NavGroup[]  // Setup item (label "Setup", href "/admin/setup", icon ListChecks, badge "setup") second in Operations or last in Integrations
```
- Layout: extend the existing select (`layout.tsx` ~26–31) with a `leftJoin(organizationSettings, eq(organizationSettings.organizationId, organizations.id))` selecting `onboardingState`; `placement = state has dismissedAt || completedSeenAt || dismissed === true ? "integrations" : "operations"` (degrade-safe: on error "integrations"); pass `setupPlacement` to `DashboardShell` → `Sidebar` and `GlobalSearch` (which builds its item list inside the component from `navGroupsFor`).
- Sidebar: badge rendering becomes a map `{ unscheduled: unscheduledBadge(count), setup: setupDigit({ data }) }` keyed by `item.badge`; the setup digit renders as a bare `font-mono text-[11px] text-muted-foreground tabular-nums` digit with `aria-label` = `srLabel`; `useOnboarding()` subscribes here; refresh on `usePathname()` change to `/admin` or `/admin/setup`.
- Primitives: `SectionCard` gains `meta?: string` (rendered mono muted in the header, before `count`); new `StepGlyph({ state: "done"|"todo"|"attention", number })` built on `IconChip` intents.
- [ ] Steps: failing tests (`shouldRefresh`, `setupDigit` all branches, `navGroupsFor` both placements + Setup searchable) → implement → `npx tsc` → screenshot `/admin` at 1440 to see the Setup item and digit (dev org state permitting; otherwise note) → gates → commit `feat(onboarding): client store, setup digit, server-side nav placement, SectionCard meta and StepGlyph`.

---

### Task 5: The `/admin/setup` page

**Files:** `src/app/admin/(dashboard)/setup/page.tsx`, `src/components/admin/setup/setup-page-client.tsx`, `setup-hero.tsx`, `setup-phase-card.tsx`, `setup-step-row.tsx`, `setup-finished.tsx`, `copy-sign-in-link.tsx`, `src/lib/admin/setup-view.ts` (+test: pure grouping `phasesOf(payload)`, `heroFor(payload)` → `{ kind: "attention"|"upnext"|"finished"|"none", step? }`, `phaseMeta`, `collapsedPhases`, subtitle/dismissed-note selection, `estimateText`).

Composition per spec §8: `PageShell narrow`, `PageHeader` with subtitle (+ dismissed note), hero `SectionCard "Up next"` / needs-attention / finished (`setup-finished.tsx` with the three wins verbatim and "Go further"), three phase `SectionCard`s with `meta` and `StepGlyph` rows, an "Optional" `SectionCard` with meta "Go further · N of 4", `CopySignInLink` (clipboard API; "Copied" + `Check` 1.5 s; no confirmation on failure; URL as selectable mono text below; instruction lines). Loading: skeletons after 300 ms (`useEffect` timer); error: `ErrorState` with retry → `refreshOnboarding({ force: true })`. The row that flipped to done gets `transition-[opacity,transform] duration-[var(--dur-enter)]` from a `data-just-done` attribute computed by diffing the previous snapshot (pure `justDone(prev, next)` in `setup-view.ts`). Phases whose required steps are done collapse at 390 (details/summary).
- [ ] Steps: failing `setup-view` tests → build → screenshots at 1440 and 390 on dev (states: fresh — set by SQL on a throwaway org? No: use the dev org as-is and ALSO temporarily render with a mocked payload through a `?preview=fresh|finished|attention` dev-only query param guarded by `NODE_ENV !== "production"`, documented in `page-setup`) → look at them → gates → commit `feat(onboarding): setup guide page`.

---

### Task 6: Home card, deep-link hook, banners, page wiring

**Files:** `src/components/admin/onboarding/setup-card.tsx` (replaces `onboarding-checklist.tsx`, deleted), `src/app/admin/(dashboard)/page.tsx` (~30), `src/hooks/use-open-from-param.ts` + `src/lib/admin/open-from-param.ts` (+test: `parseOpenParams(search, allowed) → { open?: string; fromSetup: boolean }`, `stripParams(search) → string`), `src/components/admin/setup/back-to-guide-banner.tsx`, `src/app/admin/(dashboard)/staff/page.tsx` (~34–38, ~106–114: `new=technician` → `setFormOpen(true)`, `new=invite` → `setInviteOpen(true)`; success handlers of the form, invite and reset-password dialogs call `refreshOnboarding({ force: true })` when `fromSetup`), `src/app/admin/(dashboard)/pricebook/page.tsx` (hook declared BEFORE `useUrlFilterSync` at ~70; `new=1` → `setFormOpen(true)`; `onSuccess` → refresh), `src/app/admin/(dashboard)/requests/page.tsx` (hook before ~58; `new=1` → `setCreateOpen(true)` and pass `initialScheduleOpen`; `onCreated` → refresh), `src/components/admin/request-create-dialog.tsx` (`initialScheduleOpen?: boolean` prop applied inside `reset()` ~268: `setDraft({ ...EMPTY_DRAFT, scheduleOpen: initialScheduleOpen ?? false })`), `src/app/admin/(dashboard)/settings/page.tsx` (`from=setup` → banner; wrap `settings.saveConfig` so a `true` result on business/branding/embed tabs refreshes the store), `src/components/admin/staff-form-dialog.tsx` (~226 title "Add staff member"), `embed-panel.tsx` (call `invalidateOnboarding()` after the copy PATCH).

Banner states (spec §2): default "Setup guide: <title> · Back to guide"; after refresh: done → "Done · Back to guide" (inline `Check` with a 120 ms opacity transition); still open with `note` → "Saved. <note> · Back to guide" (the request case renders "Saved. Pick a time and a technician on that request to finish this step · Back to guide"); invite created → "Invite created. This step completes when they accept it · Back to guide". The banner reads the step from the store by id (Staff → `add_technician`, Pricebook → `pricebook`, Requests → `book_first_request`, Settings → by tab: business → `phone_hours`, branding → `brand`, embed → `chat_widget`).
Home card: `SectionCard "Setup guide"` with `meta`, Up-next CTA (or `CopySignInLink`), two more rows with the Optional badge, "See all steps", × → optimistic PATCH `dismissed` with rollback copy; finished state (three wins) until × → PATCH `completedSeen`; demo → `sessionStorage` instead of PATCH; hidden when `dismissedAt`/`completedSeenAt`.
- [ ] Steps: failing `open-from-param` tests (whitelist, unknown values ignored, strip keeps other params, `fromSetup`) → implement hook + banner + card + wiring → probes on dev as admin: `/admin/staff?new=technician&from=setup` opens the form (screenshot), URL stripped after mount, refresh does not reopen; `/admin/requests?new=1&from=setup` opens with the schedule panel expanded (screenshot); `/admin/pricebook?new=1` opens the item form and filters still restore from a URL with `?q=`; `/admin/settings?tab=business&from=setup` shows the banner; home card screenshot at 1440 → gates → commit `feat(onboarding): setup card on home, deep links that open dialogs, back-to-guide banners`.

---

### Task 7: Integration suite, probes, docs

**Files:** `tests/integration/onboarding-state.test.ts`, `vitest.config.ts` (`INTEGRATION_SUITES`), `.claude/skills/page-setup/SKILL.md` (new), updates to `page-dashboard`, `page-settings`, `page-staff`, `page-requests`, `page-pricebook`, `page-tech`, `admin-pages` (deep-link recipe), `replica/build-log.md` (one entry; not a replica feature row).

Integration test (manual, `npm run test:integration`): `vi.mock("server-only", () => ({}))`; load `.env.local` like `scripts/agent/seed-org.mjs:56-58`; refuse `ep-withered-hill`; create two orgs via `createOrgCore({ skipOrgCountCheck: true, … })`; seed org B "done" by SQL; cases per spec §9.9–9.10 (concurrent stamps via `Promise.all` of two `getOnboarding` with different signal fakes? — no: drive two real `stampStatementSql` executes with different `newStamps` concurrently; PATCH `embedCopied` vs the tech-hook statement concurrently; row-less org; repeated `dismissed`; empty-`$keys` grandfather write; tenancy byte-identical); delete both orgs (cascade) in `afterAll`.
End-to-end probe on dev (admin token; SQL rows only): a throwaway org is NOT created on dev (org creation may trigger provisioning side effects) — instead use the dev org: `GET /api/admin/onboarding` shape; PATCH flows; the demo org (`DEMO_ORG_ID` IS the dev org) → confirm no writes happen (state unchanged after GET/PATCH) and `tech_sign_in` derives done. Record results.
- [ ] Steps: write the suite → run it against dev (report pass/fail verbatim) → probes → docs → `verify-skills` 0 missing → gates → commit `test(onboarding): integration suite for stamps and flags; docs and skills for the setup guide`.

---

## Self-review notes

- Spec coverage: §2 surfaces (T4 digit/placement, T5 page, T6 card + banners), §3 steps (T2 defs), §4 behaviour (T2 rules, T4 store, T6 hook), §5 flags (T3), §6 data (T1), §7 API (T3), §8 UI (T4/T5/T6), §9 acceptance (T7 + per-task tests). Not in scope per spec non-goals: tours, video, sample data, per-user state.
- Review Focus pins: 1 → T2 tests + T7; 2 → T1 render tests + T7 suite; 3 → T2 + T4 tests; 4 → T6 tests + probe; 5 → T1 render test + T7 suite.
- Cross-task names: `StepId`, `OnboardingState`, `Signals`, `parseOnboardingState`, `onboardingSelectSql`, `stampStatementSql`, `flagsStatementSql`, `STEP_DEFS`, `deriveSteps`, `grandfatherDecision`, `upNext`, `OnboardingPayload`, `getOnboarding`, `patchOnboarding`, `useOnboarding`, `refreshOnboarding`, `invalidateOnboarding`, `setupDigit`, `navGroupsFor`, `SetupPlacement`, `StepGlyph`, `SectionCard.meta`, `parseOpenParams`, `BackToGuideBanner`, `CopySignInLink` — each defined once and consumed by name.
- Known ambiguity resolved: the dev org IS the demo org (`DEMO_ORG_ID` = `00000000-…0001`), so dev probes exercise the demo path; non-demo behaviour is covered by the integration suite's throwaway orgs.
