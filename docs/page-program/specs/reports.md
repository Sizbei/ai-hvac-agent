# reports — target-state spec

`/admin/reports` — the operator sales dashboard.

## 1. Purpose

Let an owner/admin see, for a chosen period (30/90/365 days), how much money
actually came in, what's still owed, how the estimate pipeline is converting,
which lead sources and locations are paying off, and how each technician is
performing — one screen, real numbers, honest gaps (never a fabricated `0`).
One job: turn Stage-9 money tables (estimates/invoices/payments/refunds) into
a trustworthy sales scorecard, not a dashboard that lies by omission.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **`db.batch()` inside each aggregate function** — shipped. Rejected
  alternative: `Promise.all` of individual `db.select()`s (the pre-2026-07
  shape). Reason: neon-http bills each `db.select()` as its own HTTPS
  round-trip; batching the sub-queries per function inside one `db.batch()`
  cut the reports endpoint from ~18 round-trips to 4 (one per aggregate
  function). verified — every one of `getSalesReport` /
  `getLeadSourceBreakdown` / `getLocationBreakdown` /
  `getTechnicianScorecards` ends its query list in `db.batch([...] as
  const)` (`src/lib/admin/reporting-queries.ts:97,316,484,638`).
- **Client-side 60s SWR cache with latest-wins fetch cancellation** —
  shipped. Rejected: a naive "drop new fetch if one is in flight" guard
  (the pre-fix shape flagged in `docs/ADVERSARIAL-REVIEW-2026-07.md:134-136`
  — rapid preset-switching silently dropped the newer range). The current
  hook resets `isFetchingRef` in the effect's cleanup (fires before the next
  effect body runs on `cacheKey` change), so switching presets always starts
  a fresh fetch instead of a stale one winning. verified
  (`src/hooks/use-reports.ts:149-154,205-208`).
- **Server aggregation, not client-side reduction** — shipped. Rejected:
  fetch raw rows and sum in the browser. Reason: money math (native/synced
  split, refund netting, close-rate denominators) must be correct and
  tenant-scoped in one place; the API returns pre-aggregated cents, the page
  only formats them (`src/lib/admin/money-format.ts` `formatCentsExact`).
  verified.
- **Route-level response caching (`unstable_cache`, 5-min, org-tagged)** —
  recommended by the 2026-07 perf audit alongside the `db.batch` fix
  (`docs/PERF-AUDIT-2026-07.md:34`) but never implemented — `grep -rl
  unstable_cache src/` returns nothing repo-wide. Not rejected outright; see
  Gap Greports-4 (P2, backlog — this run only takes P0/P1).
- **Period-over-period trend arrows (like `/admin/operations`)** — rejected
  for this spec. `/admin/operations` already owns trend context for the
  metrics that need same-day sensitivity (response time, time-to-paid, AR
  aging) via a doubled query (current window + previous window,
  `.claude/skills/page-operations/SKILL.md`). Doing the same here would
  double reports' already-flagged query count (Greports-4) for a page whose
  numbers (revenue, close rate) are reviewed at 30/90/365-day cadence, not
  daily — no evidence of demand for day-over-day sales trend arrows.
- **CSV / export button** — rejected. `/admin/accounting` already owns the
  one QuickBooks-compatible CSV export path for money data
  (`.claude/skills/page-accounting/SKILL.md`); a second export surface on
  Reports would fragment "the" export path and duplicate date-range-picker
  logic for no evidenced need.
- **Custom date-range picker (not just the 3 presets)** — rejected. The API
  already accepts arbitrary `from`/`to` (`src/app/api/admin/reports/route.ts:38-43`,
  exercised directly by tests) so this would be a UI-only add, but no owner
  has asked for anything other than the three standard sales-review windows
  (30/90/365) — speculative scope, not requested.
- **Row-level drill-down (click a lead-source/location/tech row → filtered
  requests/invoices list)** — rejected. Real UX value, but scope creep for
  this pass; no evidenced complaint that the current read-only tables block
  a workflow. Revisit if an owner asks.
- **Revenue trend chart / sparkline** — rejected. The design system's admin
  primitives (`src/components/admin/ui/`) have no chart primitive today; the
  `StatCard` sublabel already carries the gross/refunded/synced breakdown in
  text. Adding a charting dependency for one page is disproportionate. YAGNI.
- **Scheduled/emailed weekly report** — rejected. No email-sending or
  cron/report-scheduling infrastructure exists in this repo for admin
  reports; building it is a different-sized project, not a page fix.

## 3. Current state

**Pages / components** (verified):
- `src/app/admin/(dashboard)/reports/page.tsx` — `'use client'` page; 3 date
  presets (30/90/365 days) drive a memoized `range` (`:44-48`, memoized on
  `[days]` only — a fresh `Date` every render would refetch every render,
  per the inline comment and the page skill's documented gotcha). Renders 3
  primary `StatCard`s (net revenue, outstanding AR, estimate close rate),
  4 secondary `StatCard`s, then three `SectionCard` tables (lead source,
  location, technician), each client-sorted `revenueCents` desc via an
  immutable `[...rows].sort(...)` copy (`:215-218,261-264,305-308`).
- `src/hooks/use-reports.ts` — SWR hook: seeds state from a 60s
  module-level cache (`createSwrCache`, `:78`), keyed by minute-truncated
  ISO range (`:86-89`) so switching back to a recently-viewed preset within
  the same minute reuses cache. `isLoading` is true only on an empty-cache
  first load; `isRevalidating` covers background refetches with stale data
  already painted (`:115-124`).
- `src/app/api/admin/reports/route.ts` — `getAdminSession` gate (401 if
  absent, `:23-26`), `slidingWindow` rate limit (`RATE_LIMITS.adminRead`,
  `:28-35`), `from`/`to` parsed and validated (`NaN` → 400
  `VALIDATION_ERROR`, `from > to` → 400, `:37-50`), then the 4 aggregate
  functions run via `Promise.all` (`:58-63`) — each is internally
  `db.batch()`-backed, so this is 4 concurrent independent reads, not a
  transaction (no `db.transaction()` anywhere in this file — correct per
  the neon-http invariant).
- `src/lib/admin/reporting-queries.ts` (767 lines) — every query is
  `withTenant`-scoped, with every joined table carrying its own
  `organizationId` predicate (module doc, `:1-11`; verified per-function,
  e.g. `:106-114,340-342,509-511`). Money stays integer cents; `neon-http`
  aggregate strings are coerced via `toNumber` (`:71-74`).

**Money-basis facts** (verified, load-bearing for Gaps below):
- `getSalesReport`'s `grossCollectedCents`/`netCollectedCents` are **payment
  events** (`sum(payments.amountCents)` for `succeeded`/`refunded` rows,
  `:102-114`) minus refunds (`:121-131`) — a **cash/collected** basis. Its
  doc comments are explicit about this (`:36-52`).
- `getLeadSourceBreakdown`'s `revenueCents` is also payments-minus-refunds
  attributed back to the lead's request cohort (`:354-408`) — the same
  **collected** basis as the headline KPI.
- `getLocationBreakdown`'s `revenueCents` is `sum(invoices.totalCents)` on
  the location's jobs — the query's own comment calls this "BILLED revenue"
  (`:440-449,499-505`) — a **billed/accrual** basis, not collected.
- `getTechnicianScorecards`'s `revenueCents` is the same
  `sum(invoices.totalCents)` **billed** basis (`:616-617,666-669`).
- All four render under an identical unqualified column header "Revenue" in
  the UI (`page.tsx:95` "Net revenue (period)", `:242` lead-source table,
  `:287` location table, `:332` technician table) — see Greports-2.

**Estimate lifecycle facts** (verified, load-bearing for Gaps below):
- `estimateStatusEnum` has 4 values: `open`, `sold`, `dismissed`, `expired`
  (`src/lib/db/schema.ts:2626-2630`).
- `getSalesReport`'s estimate-bucket query only branches on `'sold'`
  (`reporting-queries.ts:159`), `'expired'` (`:160-166`, including
  lazy-expired `open` rows), and `'open'`-and-not-expired (`:167-172`).
  There is no `'dismissed'` branch. `estimatesCreated` is a plain `count()`
  (`:158`) that includes dismissed rows; none of the three decided buckets
  do.
- `closeRatePct`'s denominator is `estimatesOpen + estimatesSold +
  estimatesExpired` (`:232-236`) — dismissed rows are excluded structurally,
  not just from the numerator.
- The UI sublabel reads `"${sold} sold of ${open+sold+expired} decided"`
  (`page.tsx:124`) — see Greports-1.
- By contrast, `/admin/estimates`' canonical bucket classifier
  (`src/lib/admin/estimate-queries.ts:239-245`, comment: "Single source of
  truth for bucket classification") explicitly groups `status IN
  ('dismissed','expired')` together as `'lost'` — i.e. the page this KPI is
  named after treats a dismissed estimate as a real, decided, "lost"
  outcome. Reports does not.

**Null-safety / copy** (verified): `EMPTY = '—'` constant
(`page.tsx:182`), `formatRating`/`formatHours` never coerce `null` to `0`
(`:184-190`); `formatCentsExact` used everywhere money is rendered, no raw
arithmetic in the component; error copy is human ("Failed to load report",
"Could not connect to server. Please try again.", `page.tsx:87,
use-reports.ts:166,196`) — no `err.message` reaches the UI.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Greports-1: `dismissed` estimates are silently invisible in the sales report — excluded from close rate, from the "decided" count, and from every bucket, while `/admin/estimates` treats the same status as a real "lost" outcome | P0 | `src/lib/db/schema.ts:2626-2630` (enum has `dismissed`); `reporting-queries.ts:156-172` (bucket CASE has no `dismissed` branch — only counted in plain `created`, line 158); `reporting-queries.ts:232-236` (`closeRatePct` denominator excludes it); `page.tsx:124` (sublabel calls `open+sold+expired` "decided" while dismissed — a genuinely decided/declined outcome — isn't in that sum, and isn't shown anywhere else on the page either); `estimate-queries.ts:239-245` ("Single source of truth" bucket SQL buckets `dismissed` with `expired` as `'lost'` on the Estimates page). Net effect: `estimatesCreated` can exceed the sum of the three shown buckets with zero explanation visible anywhere, and the headline "Estimate close rate" is computed over an incomplete, undisclosed subset of estimates. |
| Greports-2: the "Revenue" column means two different things on the same page (collected cash vs. billed/invoiced) with an identical label and no disclosure | P1 | Collected basis: `reporting-queries.ts:36-52` (headline KPI, payments-minus-refunds) and `:283-287,354-408` (lead-source table, same payments basis). Billed basis: `:440-449,499-505` (location table, comment says "BILLED revenue") and `:616-617,666-669` (technician table, comment says "billed revenue"). All four render under the bare header "Revenue" (`page.tsx:95,242,287,332`) with no qualifier — an owner comparing "Net revenue (period)" to the sum of the location table's "Revenue" column is comparing cash-in to billed-not-necessarily-collected, with no indication that's happening. |
| Greports-3: "…decided" sublabel counts still-`open` (undecided) estimates as decided | P2 | `page.tsx:124` labels `report.estimatesOpen + report.estimatesSold + report.estimatesExpired` as "decided", but `estimatesOpen` is explicitly the not-yet-expired, pending bucket (`reporting-queries.ts:167-172`) — i.e. not decided. Copy-precision issue, not a math bug (each individual count is correct); low severity, backlog per METHOD.md's severity gate. |
| Greports-4: no route-level response cache; every page view re-runs ~12-18 DB round trips | P2 | `docs/PERF-AUDIT-2026-07.md:34` recommended `unstable_cache` (5-min, org-tagged) on this route alongside the `db.batch` fix; the batch fix shipped (`reporting-queries.ts:97,316,484,638`) but `grep -rl unstable_cache src/` (repo-wide) returns nothing — never implemented, for this route or any other. Client-side 60s SWR caching (`use-reports.ts:78`) only helps repeat views from the same browser tab, not concurrent admins on the same org. Perf-only, not broken; backlog. |

That's the full list. Tenancy scoping, money formatting, null-vs-zero
honesty, the GROUP BY 500 that a prior audit found and fixed
(`docs/ADVERSARIAL-REVIEW-2026-07.md:34-44`, confirmed still fixed — the
current code uses inline `coalesce(cast(... as text), 'literal')` with
`.groupBy(sourceKey)`/`.groupBy(locationKey)` on the same expression, e.g.
`reporting-queries.ts:314,329,482,497`), and the latest-wins fetch fix are
all solid and evidenced above; this spec does not invent additional work to
pad it out. The date-range/timezone lens (Eastern boundaries) does not apply
here the way it does on `/admin/accounting` or `/admin/invoices`: the report
period is a rolling `now() − N days` window (`page.tsx:44-48`), not a
calendar-day/midnight boundary, so there is no Eastern-midnight off-by-one
class of bug to find on this page — verified by inspection, no calendar-day
snapping anywhere in `reporting-queries.ts`.

## 5. Requirements

Only Greports-1 and Greports-2 clear the P0/P1 bar.

- **Rreports-1**: Every estimate created in the period is accounted for
  somewhere in the report's estimate numbers — no status silently vanishes.
  **Acceptance criterion**: for an org with `N` `dismissed`-status estimates
  created in-period, the sum of every bucket `getSalesReport` returns for
  estimates equals `estimatesCreated` (i.e. add an `estimatesDismissed`
  field and either fold it into the close-rate math consistently with
  `/admin/estimates`' "lost" grouping — `dismissed` + `expired` — or keep it
  separate but visible). The UI sublabel must not claim a count is "decided"
  while excluding a real decided outcome. A `vitest` unit test in
  `reporting-queries.test.ts` asserts: given estimates in all 4 statuses,
  every one is represented in the returned bucket counts (no created
  estimate is dropped).
- **Rreports-2**: The "Revenue" label is never used unqualified when the
  underlying figure is billed (invoiced) rather than collected (cash), or
  vice versa. **Acceptance criterion**: the By-location and Technician
  scorecard `SectionCard`s disclose the billed basis (e.g. via their
  existing `action` description text, matching the pattern the headline
  `StatCard` sublabel already uses for gross/refunded/synced) so a reader
  cannot mistake `LocationBreakdownRow.revenueCents` /
  `TechnicianScorecardRow.revenueCents` for the same cash figure as "Net
  revenue (period)". No query/aggregate logic changes — this is a
  labeling/disclosure fix only.

## 6. Non-goals

- Not adding period-over-period trend arrows, a custom date-range picker,
  CSV export, row-level drill-down, a chart/sparkline, or scheduled email
  reports — see Brainstorm rejections above, all YAGNI for this pass.
- Not implementing route-level `unstable_cache` (Greports-4, P2) — recorded
  in Gaps and left in the backlog per METHOD.md's severity gate; it's a
  perf improvement, not a correctness fix.
- Not touching the "…decided" copy-precision nit in isolation
  (Greports-3, P2) beyond whatever Rreports-1's fix naturally implies for
  that sentence — it's not worth a standalone requirement at P2.
- Not changing how `getLocationBreakdown`/`getTechnicianScorecards` compute
  revenue (billed basis) — that basis is a defensible, intentional choice
  (comment-documented) for "what did this location/tech generate in
  invoiced work"; Rreports-2 only requires disclosing it, not changing it to
  match the collected basis.
- Not adding a `dismissed`-aware retroactive backfill/migration — Rreports-1
  is a read-query fix over existing rows; no schema change needed (the
  `dismissed` status and its rows already exist).

## 7. Invariants

- **Tenancy** — every aggregate in `reporting-queries.ts` is
  `withTenant`-scoped on every joined table, not just the base table
  (module doc, `:1-11`); Rreports-1/2 must not introduce an unscoped join.
- **Money in integer cents, formatted only via `formatCentsExact`**
  (`src/lib/admin/money-format.ts`) — no raw currency arithmetic in
  `page.tsx`.
- **Null metrics render `—`, never a misleading `0`** — the `EMPTY`
  constant and `formatRating`/`formatHours` helpers (`page.tsx:182-190`);
  any new field Rreports-1 adds (e.g. `estimatesDismissed`) must follow the
  same rule if it can be legitimately absent (it can't — dismissed count is
  always a real integer ≥ 0, so plain `0` is correct there, not `—`).
- **Breakdown tables sort client-side, immutably** — `[...rows].sort(...)`,
  never mutate the hook's array (page skill invariant,
  `page.tsx:215-218,261-264,305-308`).
- **`db.batch()`, never `db.transaction()`** — neon-http throws on
  `.transaction()` at runtime; every multi-query read in this file already
  uses `.batch()` (repo-wide invariant, `AGENTS.md`).
- **Range memoization stays on `[days]`, not raw `Date` objects** —
  removing it causes an infinite refetch loop (page skill gotcha,
  `page.tsx:44-48`).
- **Copy canon** — sentence case, Unicode `…`, human error copy (no
  `err.message`/"Unknown error" in the UI) — `.claude/skills/admin-pages/SKILL.md`.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/admin/reporting-queries.ts src/app/admin/(dashboard)/reports/page.tsx src/app/api/admin/reports/route.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- `npx vitest run src/lib/admin/reporting-queries.test.ts` → all existing
  cases still pass, plus new cases for Rreports-1 (dismissed-status
  reconciliation across all 4 estimate statuses).
- Manual/visual: `npm run dev` (background) → mint an admin session
  (`npx tsx scripts/agent/mint-admin-session.mjs`) → seed at least one
  `dismissed`-status estimate in the dev DB → screenshot via
  `node scripts/agent/screenshot-page.mjs /admin/reports` and confirm (a)
  the estimate KPI sublabel no longer silently omits the dismissed row from
  its reconciliation, and (b) the By-location / Technician scorecard
  sections visibly disclose the billed-revenue basis.
