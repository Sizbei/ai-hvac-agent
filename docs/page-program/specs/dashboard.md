# Spec: dashboard (`/admin`)

## 1. Purpose

The admin home screen. Its one job: let an owner/dispatcher, in the first five
seconds of opening the app each morning, see what needs them right now —
today's arrival-window schedule, unassigned urgent/emergency requests, and
on-hold items awaiting follow-up — plus a live KPI strip for shape-of-day
context. Audience: owners and dispatchers, first screen of the session.

## 2. Brainstorm

- **Fix `getDashboardOverview` to use `db.batch()` instead of `Promise.all`.**
  ACCEPTED → Rdashboard-1. Repo invariant (`AGENTS.md:39`,
  `admin-pages/SKILL.md:64-65`): neon-http `db.batch()` is 1 HTTP round-trip
  vs `Promise.all`'s N; four other query modules already do this
  (`src/lib/admin/ai-insights-queries.ts:52`,
  `conversation-queries.ts:438`, `crm-queries.ts:866,951`). The dashboard —
  highest-traffic admin page — is the one aggregation left on `Promise.all`.
- **Surface a money/collections signal** (e.g. "N invoices overdue" tile →
  `/admin/invoices`). ACCEPTED → Rdashboard-2. The landing page is 100%
  operational and 0% financial today; `overdueCount` is already computed
  server-side by the invoices page (`page-invoices/SKILL.md:26`) — reuse it
  rather than inventing a second definition.
- **Correct the page skill's "one round-trip" claim** once Rdashboard-1
  ships. ACCEPTED as part of Rdashboard-1's done-criteria (skill updates are
  required by the program gates anyway, `METHOD.md:66-67`).
- **Response-time / dispatcher first-response KPI**, mirroring
  `/admin/operations`. REJECTED — Operations already owns this metric with
  trend arrows and a defined window (`page-operations/SKILL.md`);
  duplicating it here risks the exact metric-drift this program's lens warns
  against, for a number that isn't "act now" actionable the way an
  unassigned emergency is.
- **Revenue/"today's booked value" tile.** REJECTED — no existing query
  aggregates this; building one purely for a dashboard tile with no attached
  action is the vanity-metric anti-pattern the lens warns against. The
  overdue-invoices count is kept instead because it has a clear next action.
- **Paginate the dashboard lists.** REJECTED — deliberate per the page skill
  (`page-dashboard/SKILL.md:42-44`): this is a triage view, not the full
  list; `/admin/requests` is the paginated surface. Re-confirmed, not a gap.
- **Configurable/reorderable widgets.** REJECTED — no evidence of demand;
  adds settings-storage/drag-drop complexity to a page with a fixed,
  already-justified triage order (schedule → attention → follow-up,
  `queries.ts:1236-1240`). YAGNI.
- **Realtime push (WebSocket/SSE) instead of 30s polling.** REJECTED — 30s
  already matches the sibling conversations feed
  (`recent-conversations-card.tsx:21-24`); no evidence of staleness
  complaints; a persistent connection isn't justified here.
- **Technician on-shift/availability view.** REJECTED — that's
  `/admin/dispatch`'s job; duplicating it here dilutes the page's one clear
  purpose and re-introduces the `OPEN_STATUSES` drift risk seen in G3.
- **Batch `getOnboardingState`'s 2 sequential queries.** Real but OUT OF
  SCOPE — `onboarding-queries.ts` isn't in the `page-dashboard` skill's file
  list, and `OnboardingChecklist` fetches independently of the main overview
  payload, so it doesn't block first paint. Left as a P2 note (G5), not a
  requirement.

## 3. Current state

All claims `verified` by reading the cited files in full unless marked
`inferred`.

- Client component (`src/app/admin/(dashboard)/page.tsx:1-83`) composed from
  `PageShell`, `DashboardGreeting`, `OnboardingChecklist`, an error `Alert`,
  `DashboardStatCards`, two `DashboardListCard` rows, `RecentConversationsCard`,
  `RequestDetailSheet` (lines 19-82).
- `useDashboardOverview` (`src/hooks/use-dashboard-overview.ts:28-105`) polls
  `GET /api/admin/overview` every 30s (`POLL_INTERVAL_MS`, line 15). A
  module-level SWR cache (`createSwrCache`, line 20) paints the prior payload
  instantly on remount. `RecentConversationsCard` fetches its own separate
  slice via `useAdminConversations({ limit: 5, intervalMs: 30_000 })`
  (`recent-conversations-card.tsx:21-24`), independent of the overview call.
- Poll is equality-guarded (skip `setOverview` when payload JSON is
  unchanged, `use-dashboard-overview.ts:67-75`); `isMountedRef` blocks
  post-unmount setState (lines 39,51,56,78).
- `GET /api/admin/overview` (`src/app/api/admin/overview/route.ts:12-34`)
  requires a session (401 if absent), rate-limits per user
  (`RATE_LIMITS.adminRead`, lines 19-26), calls
  `getDashboardOverview(session.organizationId)` — tenant-scoped.
- `getDashboardOverview` (`src/lib/admin/queries.ts:1187-1266`) fetches four
  things — `getDashboardStats` (9-field aggregate, one query, lines
  1049-1104), today's schedule, "needs attention", "awaiting follow-up" —
  via `Promise.all([...])` (lines 1196-1258), **not** `db.batch()`. Each list
  query independently does `.from(serviceRequests).leftJoin(users,...)` with
  its own `withTenant(...)` and `.limit(DASHBOARD_LIST_LIMIT)`.
- `getDashboardStats` is one aggregate `SELECT` with `CASE`-driven `count()`
  columns for all 9 stats (lines 1061-1104) — real SQL, not client-side
  reduction. All buckets exclude FP/HCP-imported rows (e.g. line 1063);
  `importedPending` is the imported-only pending count shown as a "+N
  imported" suffix (`dashboard-stat-cards.tsx:44-47`, `queries.ts:1086-1088`).
- `DashboardStatCards` renders 7 fields as `StatCard`s
  (`dashboard-stat-cards.tsx:24-32,39-62`); every displayed number traces to
  `getDashboardStats` — no hardcoded/mock values found (full reads of all 4
  dashboard component files).
- "Today's schedule" = open requests with `arrivalWindowStart` in
  `[todayStart, tomorrowStart)`, window-ascending (`queries.ts:1199-1215`).
  "Needs attention" = `assignedTo IS NULL` AND status in
  `UNASSIGNED_OPEN_STATUSES = ["pending","scheduled"]` (line 455) AND urgency
  in `["emergency","high"]`, emergency-before-high then oldest-first (lines
  1217-1241; comment at 1226-1229 explains the `assignedTo IS NULL` choice —
  an assigned-but-urgent request must not leak in). "Awaiting follow-up" =
  `status = 'on_hold'` AND `followUpDate IS NOT NULL`, follow-up-ascending
  (lines 1243-1257).
- All three lists cap at `DASHBOARD_LIST_LIMIT = 50` (`types.ts:201`);
  `DashboardListCard` shows a "50+" badge at the cap
  (`dashboard-list-card.tsx:97-109`) — deliberately not paginated.
- `dashboardRequestSelect`/`toDashboardRequest` carry decrypted customer
  **names** only via `safeDecrypt` — no phone/email/address/transcript
  (`queries.ts:1106-1108,1157-1179`).
- `RequestDetailSheet` receives `onAssigned={refetch}` (`page.tsx:76-80`) so
  an assign re-pulls the overview and stat cards/lists re-count without a
  full reload — matches `page-dashboard/SKILL.md:38-39`.
- `OnboardingChecklist` (`onboarding-checklist.tsx:28-66`) fetches
  `GET /api/admin/onboarding` on mount, independent of the overview fetch;
  hidden when dismissed/complete. Backed by real DB reads
  (`organizationSettings`, `pricebookItems` counts,
  `onboarding-queries.ts:52-90`), not mock state.
- **neon-http `db.batch()` is the established pattern** for multi-query
  aggregation on this driver (`src/lib/db/index.ts:2`,
  `drizzle-orm/neon-http`): `ai-insights-queries.ts:52`,
  `conversation-queries.ts:438`, `crm-queries.ts:866,951`,
  `estimate-queries.ts:127,135`. `getDashboardOverview` is the one
  high-traffic aggregation still on `Promise.all` (`queries.ts:1196`) —
  contradicts `AGENTS.md:39` and `admin-pages/SKILL.md:64-65`, and
  contradicts the page skill's own claim that the four reads run "in one
  round-trip" (`page-dashboard/SKILL.md:27`) — `inferred`: that line
  describes intent, not the actual `Promise.all` mechanism.
- **Two module-local `OPEN_STATUSES` constants disagree.**
  `queries.ts:441-447` (feeds this page's `emergencyOpen` count) =
  `["pending","assigned","scheduled","in_progress","on_hold"]` (5 statuses).
  A separate, unrelated `OPEN_STATUSES` in `ops-insights-queries.ts:29`
  (feeds `/admin/insights-ai`, not one of the three named comparison pages)
  = `["pending","assigned","in_progress"]` (3 statuses — excludes
  `scheduled`/`on_hold`). Both module-private; nothing breaks today, but the
  same label ("open") means two status sets depending on the page.
  `/admin/operations`, `/admin/invoices`, `/admin/accounting` were checked
  directly (`page-operations/SKILL.md`, `page-invoices/SKILL.md`,
  `page-accounting/SKILL.md` — full reads) and define no same-named "open
  requests" metric, so there is no P0 conflict against the three named
  pages; the drift against `insights-ai` is a lower-severity finding (G3).
- No unit test targets the dashboard components (client-only, no jsdom/RTL
  per repo convention); `getDashboardStats`/`getDashboardOverview` are
  covered by `src/lib/admin/queries.test.ts:789,841` (`describe` blocks).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| `getDashboardOverview` aggregates 4 independent queries via `Promise.all` instead of `db.batch()`, contradicting the repo-wide neon-http invariant and every sibling multi-query aggregation | P1 | `src/lib/admin/queries.ts:1196-1258`; `AGENTS.md:39`, `.claude/skills/admin-pages/SKILL.md:64-65`; sibling pattern at `ai-insights-queries.ts:52`, `conversation-queries.ts:438`, `crm-queries.ts:866,951` |
| The first screen every session shows zero financial/collections signal; an owner only learns about overdue invoices by separately visiting `/admin/invoices` | P1 | `src/app/admin/(dashboard)/page.tsx:19-82` (no money component); `overdueCount` already computed server-side, `page-invoices/SKILL.md:26` |
| Two module-private `OPEN_STATUSES` constants define "open" with different status sets (5 vs 3) — definitional-drift risk for future work even though nothing currently reads across them | P2 | `src/lib/admin/queries.ts:441-447`; `src/lib/admin/ops-insights-queries.ts:29` |
| `page-dashboard/SKILL.md:27` claims the overview query runs "in one round-trip", inaccurate while `Promise.all` (not `db.batch`) is used | P2 | `.claude/skills/page-dashboard/SKILL.md:27` vs `src/lib/admin/queries.ts:1196` |
| `OnboardingChecklist`'s `getOnboardingState` runs 2 sequential (non-batched) `db.select()` calls | P2 | `src/lib/admin/onboarding-queries.ts:57-65,82-90` (non-blocking; separate fetch) |

No P0s: every rendered number traces to real tenant-scoped SQL (no
hardcoded/placeholder values), tenancy scoping is present everywhere, and the
"needs attention" assignment-leak invariant is correctly implemented. This is
a data-honesty-clean page; the gaps are latency/consistency, not correctness.

## 5. Requirements

- **Rdashboard-1**: `getDashboardOverview` (`queries.ts:1187-1266`) uses
  `db.batch([...])` in place of `Promise.all([...])` for its four queries,
  matching `ai-insights-queries.ts`/`conversation-queries.ts`/
  `crm-queries.ts`. `page-dashboard/SKILL.md:27`'s round-trip claim is
  corrected to match reality.
  **Acceptance criterion:** `npx vitest run src/lib/admin/queries.test.ts`
  passes with the existing `getDashboardOverview`/`getDashboardStats`
  assertions unmodified (same return shape); `getDashboardOverview`'s
  function body no longer contains `Promise.all`; `npx tsc --noEmit` and
  `npx eslint src/lib/admin/queries.ts` both 0.
- **Rdashboard-2**: the dashboard surfaces a real, DB-backed overdue-invoices
  signal (count, linking into `/admin/invoices`) reusing the invoices page's
  existing overdue definition (`page-invoices/SKILL.md:41-43`) — not a new,
  second definition of "overdue".
  **Acceptance criterion:** the dashboard payload/UI includes a visible
  element showing the current overdue-invoice count, sourced from a
  tenant-scoped query that reuses (imports or matches verbatim) the overdue
  SQL predicate at `page-invoices/SKILL.md:41-43`; clicking it navigates to
  `/admin/invoices`; a pure-helper vitest test asserts the count matches
  `invoice-queries.ts`'s overdue predicate for a fixture set of invoices.
  `npx tsc --noEmit` and `npx eslint <changed>` both 0.

G3-G5 (P2) are recorded as backlog per the severity gate (`METHOD.md:41-43`)
and are not implementation work in this pass.

## 6. Non-goals

- No response-time/dispatcher-first-response KPI — `/admin/operations`
  already owns it; duplicating risks the metric-drift this program's lens
  flags. A link/CTA to Operations is sufficient if wanted later.
- No revenue/"booked value" vanity tile — no existing query aggregates it,
  and it has no clear next action, unlike overdue invoices.
- No pagination of the three dashboard lists — the 50-row cap + "50+" badge
  is deliberate; `/admin/requests` is the full list.
- No configurable/reorderable widget layout.
- No realtime push (WebSocket/SSE) replacing the 30s poll.
- No technician on-shift/availability view — that's `/admin/dispatch`'s job.
- No fix to G3 (`OPEN_STATUSES` drift vs `insights-ai`), or G5 (onboarding
  query batching) in this pass — P2 backlog, kept out to stay surgical.

## 7. Invariants

- Poll equality-guard: skip `setOverview` when the payload is byte-identical
  to the last tick. Source: `use-dashboard-overview.ts:67-75`,
  `page-dashboard/SKILL.md:31-33`.
- `isMountedRef` must gate every post-await `setState` in
  `useDashboardOverview`. Source: `use-dashboard-overview.ts:39,51,56,78`.
- "Needs attention" must filter on `assignedTo IS NULL`, never status alone.
  Source: `queries.ts:1226-1230`, `page-dashboard/SKILL.md:35`.
- Urgency order stays emergency-before-high, then oldest-first. Source:
  `queries.ts:1236-1240`, `page-dashboard/SKILL.md:36-37`.
- `RequestDetailSheet.onAssigned` must keep calling `refetch`. Source:
  `page.tsx:76-80`, `page-dashboard/SKILL.md:38-39`.
- The three lists stay capped at `DASHBOARD_LIST_LIMIT` (50), un-paginated.
  Source: `types.ts:201`, `page-dashboard/SKILL.md:42-44`.
- `dashboardRequestSelect`/`toDashboardRequest` must keep excluding
  phone/email/address/transcript. Source: `queries.ts:1106-1108,1157-1179`.
- Tenancy: every dashboard query stays scoped by `organizationId` via
  `withTenant(...)`. Source: `AGENTS.md:42`; verified at
  `queries.ts:1091,1205,1223,1249`.
- neon-http: never introduce `db.transaction()` — it throws at runtime; any
  new batching in Rdashboard-1/Rdashboard-2 uses `db.batch()`. Source:
  `AGENTS.md:39`.
- FROZEN AI safety text/guardrail regexes are untouched — this page makes no
  `/lib/ai` calls. Source: `AGENTS.md:36-38`.
- Copy canon applies to any new copy (e.g. Rdashboard-2's overdue-invoice
  label). Source: `admin-pages/SKILL.md:48-54`.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint <changed files>` → 0 errors.
3. `npx vitest run` → must not drop below the run's captured baseline (297
   files · 4022 passed · 1 skipped, `docs/page-program/README.md:7`).
4. `npx vitest run src/lib/admin/queries.test.ts` → the existing
   `getDashboardStats`/`getDashboardOverview` describe blocks
   (lines 789,841) pass unmodified in assertions, proving Rdashboard-1's
   `db.batch()` swap preserves the same return shape.
5. Visual: `npm run dev` (background), mint a session
   (`npx tsx scripts/agent/mint-admin-session.mjs`), then
   `node scripts/agent/screenshot-page.mjs /admin 1440` and `... 390` — look
   at both; confirm Rdashboard-2's new element renders without regressing
   the existing stat-card/list-card layout.
6. `node scripts/agent/verify-skills.mjs` → 0 missing paths; re-run after
   updating `.claude/skills/page-dashboard/SKILL.md` (round-trip correction
   + Rdashboard-2's new file/query citation).
