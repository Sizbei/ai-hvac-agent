# operations — target-state spec

`/admin/operations` — the owner-facing operational health scorecard.

## 1. Purpose

Let an owner glance at one page and know: how fast we reach customers, how
long jobs take to complete, how fast we get paid, how many jobs we booked,
and how healthy dispatch (manual + auto) currently is — each headline with a
period-over-period trend, and open receivables broken out by age. One job:
a trustworthy daily-glance scorecard an owner can act on, never a
misleading number dressed up as insight.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Deterministic KPI math, live from source tables (no rollup table)** —
  shipped. Rejected: a `demand_daily`-style precomputed rollup. Reason: at
  current scale (hundreds–low-thousands of rows/year) live aggregation is
  well within budget and stays unit-testable against the array-returning DB
  mock; the rollup seam is left as a comment, not built speculatively
  (`operations-metrics-queries.ts:9-14`, verified). YAGNI.
- **Period-over-period trend arrows on every headline** — shipped
  (`MetricTrend` + `durationDelta`/`countDelta`, `page.tsx:50-65`). Rejected:
  raw current-value only. Reason: a single number has no context; an owner
  needs to know if it's improving. verified.
- **"—" instead of a false zero when there's no data** — shipped
  (`formatDuration(null)` → `'—'`, `page.tsx:34-41`; `commitRate !== null`
  gate, `:184-188`). Rejected: defaulting nulls to 0. Reason: "no paid
  invoices yet" must never look identical to "we paid instantly" — see Gaps
  for where this discipline is NOT yet applied. verified.
- **SWR client cache, stale-while-revalidate** — shipped
  (`use-operations-metrics.ts:84,130-194`). Rejected: refetch-on-every-preset
  with a full-page spinner. Reason: keeping prior numbers painted while the
  fresh fetch runs avoids a jarring blank state on a page read at human pace
  (`:97-99`). verified.
- **Native vs. synced (FieldPulse/HCP) AR shown separately, combined
  headline** — shipped (`arAging` vs `syncedArAging`, `page.tsx:199-298`).
  Rejected: one blended AR number. Reason: synced invoices are collected in
  the external system, not by this org's own AR workflow — conflating them
  would mislead an owner about what THEY need to chase. verified. This
  discipline is the standard the rest of the page is measured against in
  Gaps below.
- **Dispatch health card (commit rate + real/shadow/override counts)** —
  shipped. Rejected: folding it into "First response". Reason: commit rate
  answers "is the scoring pipeline healthy" (system-quality), first-response
  answers "how fast did a human/system act" (operational speed) — different
  fix paths when they degrade. Deliberately a *fixed* 7-day window, not the
  selected range — a pipeline-health canary, not an owner-tuned KPI
  (`dispatch-rollup.ts:1-9`, verified).
- **Custom date-range picker** — rejected. Only three fixed presets exist
  (`page.tsx:27-31`); no evidence of demand for arbitrary ranges on a
  small-business daily-glance page, and the API already accepts arbitrary
  `from`/`to` (`operations-metrics/route.ts:41-47`) so this would be a
  UI-only addition with real, unrequested cost. YAGNI.
- **CSV/PDF export** — rejected. `/admin/accounting` already is the
  dedicated export surface for financial data. Redundant.
- **Per-technician breakdown** — rejected. This is an org-level owner
  scorecard; per-tech performance belongs on `/admin/technicians`, not
  bolted onto four org-wide tiles. Scope creep.
- **Polling / auto-refresh** — rejected. `use-operations-metrics.ts:98`:
  "No polling — an owner reads this at human pace." 60s SWR TTL plus
  manual preset-switch refetch is enough for a page nobody stares at live.

## 3. Current state

**Page / hook / API** (verified, read in full):
- `src/app/admin/(dashboard)/operations/page.tsx` — 3 preset buttons
  (30/90/365 days, `:27-31`), 5 KPI tiles (response time, time-to-paid,
  requests booked, dispatcher first-response, dispatch health) plus a full-
  width AR-aging card with native and synced sub-sections.
- `src/hooks/use-operations-metrics.ts` — SWR-cached (`createSwrCache`,
  60s TTL, `:84`) fetch of `GET /api/admin/operations-metrics?from&to`;
  minute-truncated cache key so preset re-clicks within the same minute hit
  cache (`:92-95`).
- `src/app/api/admin/operations-metrics/route.ts` — admin-session gated,
  rate-limited (`adminRead`), validates `from < to`, delegates to
  `getOperationsMetrics(organizationId, period)`.
- `src/lib/admin/operations-metrics-queries.ts` (`getOperationsMetrics`,
  `:107-428`) — 10 concurrent sub-queries (`Promise.all`, `:124-135`),
  reduced in JS into the 5 headline trends + AR aging + dispatch health.

**Instrumentation the response-time / first-response KPIs depend on**
(verified): both derive from `requestStatusEvents` rows written by
`recordStatusEvent` (`src/lib/admin/status-events.ts:22-48`, best-effort —
logs and swallows on insert failure so a KPI-eventing bug can never 500 a
real transition). Every assignment path was traced:
- **Manual assign** (dispatcher button) → `assignTechnician`
  (`queries.ts:472-553`) → `recordStatusEvent({toStatus:"assigned",
  actorType:"human"})` (`:547-553`). Sole caller:
  `POST /api/admin/requests/[id]/assign` (`assign/route.ts:55`). verified.
- **Drag-drop** (calendar/dispatch board, same component) → `POST
  /api/admin/requests/[id]/reschedule` (`reschedule/route.ts:93-104`) →
  `placeAndAssignRequest` (`scheduling-queries.ts:578-797`), which records
  `toStatus:"assigned"` **only on a genuine first assignment**
  (`isFirstAssignment = reassigning && existing.assignedTo === null`,
  `:788-797`) — a pure reschedule or re-assigning an already-assigned job
  correctly does NOT re-fire the event (would double-count "first"
  response). `assignmentActor` defaults to `"human"` — correct, a human
  dragged it. verified.
- **Autopilot** (`autoAssignBookedRequest`, `scheduling-queries.ts:1239-
  1420`, called from `submit-session-request.ts:470-473`) → calls the SAME
  `placeAndAssignRequest` (`:1377-1392`), explicitly passing
  `assignmentActor: "system"` (`:1390`) — this is exactly what powers the
  "First response — dispatcher" card's `firstResponseSystemSeconds`
  sublabel split (`page.tsx:176`). verified.
- **Reassignment** (`reassignTechnician`, `queries.ts:604-`) deliberately
  does NOT flip status to `"assigned"` or fire a new event — "preserves the
  status" (`queries.ts:597-598`), so a mid-flight reassignment is correctly
  excluded from first-response. verified.
- **FieldPulse webhook** (`fieldpulse/webhook/route.ts`) maps inbound FP job
  statuses (`"assigned"`/`"dispatched"` → `"assigned"`, `:96-113`) and DOES
  call `recordStatusEvent({actorType:"system"})` (`:407-413`) on every
  mapped status change for a FP-linked request — see Gops-1: NOT excluded
  from the same two KPIs every other synced-data path on this page IS
  excluded from. verified.
- **HCP webhook** (`webhooks/housecall/route.ts` → `applyWebhookEvent`,
  `webhook-sync.ts:155`) calls `recordStatusEvent` nowhere (grepped, zero
  hits) — HCP-synced status changes never touch `requestStatusEvents`, so
  HCP jobs are (accidentally) excluded from these two KPIs. Inconsistent
  with FieldPulse's behavior on the same table. verified.
- Bulk **import** (`fieldpulse/import/jobs.ts:431`) sets `assignedTo`
  directly on insert, never calls `recordStatusEvent` — historical imports
  don't retroactively pollute the KPI. verified.

**AR reconciliation across surfaces** (verified via independent code read):
`/admin/operations` (`operations-metrics-queries.ts:248-284,410`),
`/admin/invoices` (`invoice-queries.ts:864-899`), and `/admin/reports`
(`reporting-queries.ts:133-151,225`) all use the identical definition —
`state='open'`, `sum(totalCents - amountPaidCents)`, `amountPaidCents <
totalCents` guard, same native/synced split on `fieldpulseInvoiceId`/
`hcpInvoiceId` nullity. None apply a due-date/aging cutoff to the *total*
(only the bucket breakdown). `/admin/dashboard` and `/admin/accounting`
compute no independent AR total (accounting is a CSV export over
already-computed lines). **These three surfaces reconcile.**

**Timezone**: all range boundaries (`fromDate`, `toDate_`, `prevFrom`,
`cut30`/`cut60`/`cut1day`) are plain UTC instants from `new Date()` — no
Eastern business-day alignment (`operations-metrics-queries.ts:111-122`).
Matches `reporting-queries.ts` (`:86,302,476,634`, same pattern) — an
established repo convention for rolling-window metrics, not a page-specific
bug. Calendar/scheduling code (`calendar-time.ts`) IS Eastern-aware, but
that's slot rendering, a different concern from KPI windowing. verified —
not a gap.

**Null-safety discipline**: `formatDuration(null)` → `'—'` (`page.tsx:34-
41`); `commitRate` gated `!== null` before `Math.round` (`:184-188`,
page-skill gotcha); median/average on an empty array return `null`, never
`0` (`operations-metrics-queries.ts:50-62`, tested at
`.test.ts:258-271`). verified — the "no data ≠ zero" principle from
Brainstorm holds everywhere EXCEPT the scoping gap below.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gops-1: "Response time" and "First response — dispatcher" silently blend native jobs with FieldPulse-synced jobs, unlike every other KPI on this page | P1 | The `inProgressRows` and `assignedRows` queries (`operations-metrics-queries.ts:137-193`) join `requestStatusEvents` → `serviceRequests` with NO `fieldpulseJobId`/`hcpJobId` exclusion — contrast with `paidRows` (`:201-220`, explicit `isNull(invoices.fieldpulseInvoiceId), isNull(invoices.hcpInvoiceId)`) and `jobsCurrentRow`/`jobsPreviousRow` (`:286-314`, explicit `isNull(serviceRequests.fieldpulseJobId), isNull(serviceRequests.hcpJobId)`). Meanwhile `fieldpulse/webhook/route.ts:407-413` actively writes `toStatus:"assigned"`/`"in_progress"` status events (`actorType:"system"`) for FP-linked requests on every inbound status webhook — so a FieldPulse org's live-synced job assignments/starts get folded into the "your team" response-time and first-response numbers with zero disclosure, while `timeToPaidSeconds` (same page) carries an explicit sublabel ("your invoices only · synced FieldPulse/HCP excluded", `page.tsx:139`) and `jobsBooked` shows an explicit "+N imported" suffix (`page.tsx:146-150`) for the exact same native/synced distinction. Test coverage confirms the gap: `operations-metrics-queries.test.ts` has a dedicated test scoping the paid-invoice/jobs/AR queries to native-only (`:296-336`) but no equivalent test exists for the in-progress or assigned queries. |
| Gops-2: The FieldPulse-vs-HCP webhook asymmetry (Gops-1's root cause) means an org syncing via HCP gets these two KPIs computed on native-only data by accident, while an org syncing via FieldPulse gets them silently blended — same page, different correctness depending on which integration the org uses | P2 | `fieldpulse/webhook/route.ts:407-413` calls `recordStatusEvent`; `housecall-pro/webhook-sync.ts` (`applyWebhookEvent`, `:155`) has zero `recordStatusEvent` calls (grepped). Both are real, shipped webhook handlers. Rolled into the Gops-1 fix (same root cause, same requirement) rather than tracked separately. |
| Gops-3: `inProgressRows`/`assignedRows` queries have no lower time bound — every selected preset (even "Last 30 days") scans the request's full event history to find the TRUE first occurrence | P2 | Deliberate, self-documented trade-off, not an oversight: `operations-metrics-queries.ts:148-153,163-168` explain the no-lower-bound requirement in comments, and the file's module doc (`:9-14`) names the exact scale seam ("If it ever slows, the seam to precompute into demand_daily-style rollups is here"). No evidence of current slowness at repo scale (hundreds–low-thousands of rows/year per the same doc). Recorded for completeness; not new work — the author already flagged and deferred it correctly. |

That's the full list. AR reconciliation, the assignment-event instrumentation
for every NATIVE assignment path (manual/drag/autopilot), null-vs-zero
discipline, and timezone consistency with `/admin/reports` are all solid and
evidenced above — this spec does not invent additional work to pad it out.

## 5. Requirements

Only Gops-1 (which subsumes Gops-2, same fix) clears the P0/P1 bar.

- **Rops-1**: "Response time" and "First response — dispatcher" must be
  computed from native requests only (`fieldpulseJobId IS NULL AND
  hcpJobId IS NULL`), matching every other native/synced-aware metric on
  this page, OR — if blending is ever intentionally kept — the page must
  disclose it the same way `timeToPaidSeconds` and `jobsBooked` already do
  (an explicit sublabel / count, never silent).
  **Acceptance criterion**: `inProgressRows` and `assignedRows` in
  `getOperationsMetrics` add `isNull(serviceRequests.fieldpulseJobId),
  isNull(serviceRequests.hcpJobId)` to their `withTenant(...)` filters
  (mirroring the existing `jobsCurrentRow` pattern at
  `operations-metrics-queries.ts:290-296`). A new `vitest` test in
  `operations-metrics-queries.test.ts` (alongside the existing native-only
  test at `:296` for the paid/jobs/AR queries) asserts the same
  `isNull(...fieldpulseJobId)`/`isNull(...hcpJobId)` guards appear in the
  captured `where` clause for both the in-progress and assigned selects.
  As a consequence, the FieldPulse-webhook-vs-HCP-webhook asymmetry
  (Gops-2) is closed for free — neither integration's synced status
  changes reach these two KPIs any more.

## 6. Non-goals

- Not adding a custom date-range picker, CSV/PDF export, per-technician
  breakdown, or polling/auto-refresh — see Brainstorm for each rejection.
- Not touching the AR figure or its reconciliation with `/admin/invoices` /
  `/admin/reports` — verified consistent, no bug found.
- Not touching the plain-UTC-instant windowing convention (`new Date()`
  cutoffs) — verified consistent with `/admin/reports`; changing it would
  be a repo-wide convention change out of scope for this page.
- Not building the `demand_daily`-style precomputed rollup for the
  unbounded event-history scan (Gops-3, P2, self-deferred by the original
  author with a named seam; no evidence of current slowness).
- Not touching `getDispatchOutcomeRollup` / the dispatch-health card's
  fixed 7-day window — a deliberate pipeline-health canary, not a
  date-range-scoped KPI (Brainstorm).

## 7. Invariants

- **Duration formatting**: all durations render through `formatDuration`
  (seconds → s/min/hrs/days, adaptive) — never a raw second count
  (`page.tsx:34-41`, page skill).
- **Trend polarity**: lower is better for durations (`durationDelta`),
  higher is better for counts (`countDelta`) — swapping either inverts the
  color signal (`page.tsx:50-65`).
- **AR aging bars are native-only**; synced (FieldPulse/HCP) AR renders in
  its own sub-section, shown only when `syncedArTotalCents > 0`
  (`page.tsx:257`). Rops-1 does not touch AR — only the two duration KPIs.
- **`timeToPaidSeconds` sublabel discipline**: "your invoices only ·
  synced FieldPulse/HCP excluded" must stay — Rops-1 extends this same
  discipline to response-time/first-response, it does not weaken it here.
- **No data ≠ zero**: `null` must render `'—'` via `formatDuration(null)`
  or an explicit `!== null` gate (as `commitRate` already does) — never let
  a `null` reach `Math.round` or arithmetic (page skill gotcha,
  `page.tsx:184-188`).
- **`onSiteSeconds` has no trend** — a sublabel of "Response time", not its
  own `MetricTrend` card (page skill gotcha). Rops-1 does not change this.
- **Dispatch health's 7-day window is fixed**, independent of the
  date-range presets — do not wire it to `days` (page skill, dispatch-
  rollup module doc).
- Tenancy: every sub-query in `getOperationsMetrics` scopes via
  `withTenant(..., organizationId, ...)` — Rops-1's added filters go inside
  the existing `withTenant(...)` call, never a bare `WHERE`.
- `recordStatusEvent` stays best-effort (try/catch, log-and-continue) — a
  KPI-eventing failure must never fail or roll back the real status
  transition that already committed (`status-events.ts:30-32`).

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/admin/operations-metrics-queries.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- `npx vitest run src/lib/admin/operations-metrics-queries.test.ts` — must
  stay green, plus the new Rops-1 native-only-scoping test for
  `inProgressRows`/`assignedRows`.
- Manual/visual: `npm run dev` (background) → mint an admin session →
  `node scripts/agent/screenshot-page.mjs /admin/operations` and confirm
  the "Response time" and "First response — dispatcher" cards still render
  sane values (dev DB has few/no FieldPulse-webhook-driven status events
  today, so the numeric change from Rops-1 may be invisible locally — the
  test coverage, not the screenshot, is what proves the fix).
