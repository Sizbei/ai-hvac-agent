---
name: page-operations
description: Use when working on the /admin/operations page — owner KPI scorecard showing response time, time-to-paid, requests booked, dispatcher first-response, dispatch health, and AR aging buckets.
---

# Operations (/admin/operations)

**Purpose:** owner-facing operational health scorecard — how fast you reach customers,
how long jobs take to complete, how quickly you get paid, and the current state of
open receivables. Each headline KPI shows a period-over-period trend arrow.

**Files:** page `src/app/admin/(dashboard)/operations/page.tsx` · hook
`src/hooks/use-operations-metrics.ts` · API
`src/app/api/admin/operations-metrics/route.ts` · query lib
`src/lib/admin/operations-metrics-queries.ts` · tables `service_requests`,
`invoices`, `technician_assignments`, `decision_audit`

**Data flow:** `useOperationsMetrics(range)` holds a 60 s client-side SWR cache.
Range is memoized on `[days]` (same pattern as reports — avoid re-creating `Date`
objects on every render). The API fetches current and previous windows in a
single call; both windows must cover equal-length spans for trend comparisons to
be meaningful. The dispatch-health rollup pulls from `decision_audit` (last 7 days
fixed, not the selected range).

**Invariants:**
- All duration metrics: `formatDuration` renders seconds adaptively (s → min → hrs
  → days). Never format seconds as a plain number.
- Trend arrows: lower is better for durations (`durationDelta`); higher is better
  for counts (`countDelta`). Swapping the polarity inverts the color signal.
- AR aging bars cover NATIVE invoices only; synced (FieldPulse/HCP) AR is shown
  in a separate sub-section that renders only when `syncedArTotalCents > 0`.
- `timeToPaidSeconds` sublabel explicitly states "your invoices only · synced
  FieldPulse/HCP excluded" — preserve this disclaimer.
- Dispatch health `commitRate` is a fraction (0–1); multiply by 100 for display.
- Metrics with no data: `null` renders `—` via `formatDuration(null)` returning
  `'—'`. Never let a `null` reach `Math.round` or arithmetic.
- `responseTimeSeconds` and `firstResponseHumanSeconds` (the "assigned"/
  "in_progress" `requestStatusEvents` sub-queries) filter to NATIVE requests
  only (`isNull(fieldpulseJobId)` AND `isNull(hcpJobId)`) — FieldPulse's
  webhook writes those same status events for synced jobs too
  (`fieldpulse/webhook/route.ts`), and synced jobs' response-time isn't ours
  to measure. Mirrors the `jobsCurrentRow` native-only filter already used
  elsewhere in this file — keep any new status-event query in sync.

- "First response — dispatcher" averages human first assignments EXCEPT those
  within `ASSIGNED_AT_CREATION_SECONDS` (60 s) of creation: those were booked
  with a technician already chosen, not answered by a dispatcher. Without
  this the headline read "1 s".
- AR amount columns are `w-28 shrink-0` so six-figure synced totals line up.

**Gotchas:**
- `onSiteSeconds` is not a `MetricTrend` — it has no previous value and no delta.
  It appears as a sublabel of "Response time", not its own card.
- `metrics.dispatchHealth.commitRate` is nullable even when the rollup exists
  (no committed decisions → `null`). Guard before `Math.round`.
- Dev DB: dispatch-health totals are likely 0 unless shadow-mode decisions exist.

**Verify changes:** `npx vitest run src/lib/admin/operations-metrics-queries` ·
visual via the admin-pages recipe at `/admin/operations`.
