# Operations Metrics Page — Design

**Date:** 2026-07-06
**Status:** Approved (pending spec review)
**Author:** brainstorm session (Raymond Chen)

## Goal

A dedicated **Operations** page in the admin dashboard giving the business owner
a daily-glance operational scorecard: four headline KPIs with trend arrows,
optimized for a ~10-second read. Distinct from the existing **Reports** page
(money: revenue, AR balances, close rate, tech scorecards) and **Insights** page
(ops breakdowns + AI narrative), neither of which surfaces time/flow KPIs and
neither of which is date-ranged with period-over-period trends.

## The four metrics (definitions locked in brainstorm)

| # | Metric | Headline | Secondary |
|---|--------|----------|-----------|
| 1 | Technician time to job | **Response time** — median(first `in_progress` event − request `createdAt`) | **On-site duration** — avg `technician_time_entries.minutes` |
| 2 | AR days for invoicing | **Avg days to paid** — avg(paid-date − invoice `createdAt`) over native paid invoices | **AR aging** — outstanding $ on open invoices, bucketed 0–30 / 31–60 / 60+ days |
| 3 | Customer service volume | **Jobs booked** — count of `service_requests` created in window | (per-day sparkline optional, deferred) |
| 4 | Waiting times | **Time to first response (human)** — avg(first `assigned` event where `actorType='human'` − `createdAt`) | auto-dispatch avg shown as a small muted secondary line |

### Deliberate definitional choices
- **Response time uses median, not mean.** created→in_progress is dominated by
  scheduling lead (a maintenance job booked two weeks out reads as "14 days");
  the median resists that skew. Mean would be misleading.
- **Avg days-to-paid anchors on invoice `createdAt`.** There is no "sent"
  timestamp on invoices. Paid-date = the succeeded payment's `createdAt`.
- **Days-to-paid covers native invoices only.** Synced FieldPulse/HCP invoices
  can be marked paid without a native `payments` row (money lives externally),
  so they are excluded from the average. The tile is labeled accordingly.
- **First response is the HUMAN slice.** The headline is dispatcher
  acknowledgment (`actorType='human'`) — the number the owner cares about.
  Auto-dispatched jobs (`actorType='system'`, `assigned` in seconds) are shown
  only as a small muted secondary line, never conflated into the headline.

## Prerequisite: status-event instrumentation fix (implementation step 1)

**Problem found in design review:** the `assigned` status event is only recorded
by the manual `assignRequest` path (`queries.ts`). The two dominant assignment
paths — `autoAssignBookedRequest` and `placeAndAssignRequest`
(`src/lib/admin/scheduling-queries.ts`) — update status directly and never call
`recordStatusEvent`. As-is, "time to first response" would silently measure only
manually-assigned jobs (a biased minority in an automation-first product).

**Fix:** add a best-effort `recordStatusEvent({ toStatus: "assigned", actorType })`
after the successful assignment UPDATE in both functions:
- `autoAssignBookedRequest` → `actorType: "system"`
- `placeAndAssignRequest` → `actorType: "human"` (dispatcher-initiated drag/placement)

`recordStatusEvent` is already best-effort (swallows its own errors), so these
additions cannot affect the assignment outcome. This also makes the event log
complete for any future KPI/automation consumer — it is the correct fix
independent of this feature.

`in_progress` events are already reliably recorded (tech field app and admin
transitions both route through `updateRequestStatus`), so response time and
on-site duration need no instrumentation change.

## Architecture

Live SQL aggregation mirroring the existing `getSalesReport` pattern — always
fresh, simple at current scale. All sub-aggregates run concurrently via
`Promise.all`; each headline is computed for the selected window **and** the
immediately-preceding equal-length window to power the trend delta.

*Deferred alternative (YAGNI):* pre-aggregated daily rollup tables (the codebase
already has `demand_daily` / `revenue_daily`). Note the seam in the query module
but do not build it until these queries measurably slow down.

### Files (all follow existing conventions)

| File | Role | Mirrors |
|------|------|---------|
| `src/lib/admin/operations-metrics-types.ts` | return types (readonly interfaces) | `ops-insights-types.ts` |
| `src/lib/admin/operations-metrics-queries.ts` | `getOperationsMetrics(orgId, period)` | `reporting-queries.ts` `getSalesReport` |
| `src/app/api/admin/operations-metrics/route.ts` | GET, `getAdminSession` gate, org-scoped, `?from&to`, rate-limited | `api/admin/reports/route.ts` |
| `src/hooks/use-operations-metrics.ts` | client data hook | `use-reports.ts` |
| `src/app/admin/(dashboard)/operations/page.tsx` | the scorecard page | `reports/page.tsx` |
| sidebar nav entry | link to `/admin/operations` | existing nav |
| `src/lib/admin/operations-metrics-queries.test.ts` | unit tests | `reporting-queries.test.ts` |

### Query module shape

```
getOperationsMetrics(organizationId, period: { fromDate?, toDate? }): Promise<OperationsMetrics>
```

- Default window: last 30 days (matches Reports).
- Compute the same aggregate set for `[from, to]` and the prior `[from−Δ, from]`
  where `Δ = to − from`; return `{ current, previous }` per headline so the page
  renders the delta + arrow.
- All aggregates org-scoped via `withTenant`.
- neon-http returns `count()/avg()/sum()` as strings → coerce with the existing
  `toNumber` helper pattern (see `ops-insights-queries.ts`).

### Sub-aggregates

1. **Response time** — join `request_status_events` (earliest `to_status='in_progress'`
   per request, in window by event `at`) to `service_requests.createdAt`; median
   of the second-differences. Median via `percentile_cont(0.5)`.
2. **On-site duration** — `avg(technician_time_entries.minutes)` where
   `clock_out_at` in window.
3. **Avg days-to-paid** — native invoices (`fieldpulse_invoice_id IS NULL AND
   hcp_invoice_id IS NULL`) that are paid; paid-date = max succeeded payment
   `createdAt`; avg of (paid-date − invoice createdAt) in days, over invoices
   whose paid-date is in window.
4. **AR aging** — open invoices (`amount_paid_cents < total_cents`, state in
   draft/open); `sum(total − amountPaid)` bucketed by `now − createdAt` into
   0–30 / 31–60 / 60+.
5. **Jobs booked** — `count(service_requests)` with `createdAt` in window.
6. **Time to first response** — earliest `to_status='assigned'` event per request
   (in window by event `at`) minus `createdAt`; avg. Headline = the
   `actor_type='human'` slice; the `system` slice is computed too but rendered as
   a muted secondary line.

## Page layout (owner glance)

```
┌─ Operations ────────────────────  [ 30d | 90d | 365d ] ─┐
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│  │ RESPONSE TIME│ │ AVG DAYS TO  │ │ JOBS BOOKED  │     │
│  │  1.8 days    │ │   PAID       │ │    142       │     │
│  │ ▼ 0.3 vs prev│ │  6.2 days    │ │ ▲ 12% vs prev│     │
│  │ on-site ~95m │ │ ▲ 0.8 vs prev│ │              │     │
│  └──────────────┘ └──────────────┘ └──────────────┘     │
│  ┌──────────────┐   AR aging (open):                    │
│  │ FIRST RESP.  │     0–30d  $4,200                      │
│  │ (dispatcher) │     31–60d $1,100                      │
│  │  2.4 hrs     │     60+d   $  600                      │
│  │ ▼ 18m vs prev│                                        │
│  │ auto: 42s    │  (muted secondary)                     │
│  └──────────────┘                                        │
└──────────────────────────────────────────────────────────┘
```

Four big-number tiles, each with a period-over-period delta arrow (green good /
red bad, direction per metric — lower is better for times, higher for volume).
AR aging is a small breakdown beside its tile; on-site duration and the
auto/human first-response split ride as secondary lines on their tiles.
Date-range presets: 30 / 90 / 365 days (matches Reports). Loading = skeletons;
empty/zero states render "—" not a misleading 0.

## Error handling
- API route: `getAdminSession` gate (401), rate-limited (`adminRead`), invalid
  date range → 400, query failure → 500 with logged context. Mirrors reports route.
- Query module: each aggregate independent; a metric with no qualifying rows
  returns null → page shows "—". No metric failure cascades to the others
  (all in one `Promise.all`, but each sub-select is self-contained).

## Testing
- `operations-metrics-queries.test.ts`: mock `@/lib/db` chainable proxy +
  `drizzle-orm` (include `sql`, `avg`, `count`, `sum`, `gte`, `lte`, `and`,
  `eq`, `inArray`, `isNull`), assert each aggregate's shape and the
  current/previous window computation. Mirror `reporting-queries.test.ts`.
- Instrumentation fix: extend the `autoAssignBookedRequest` /
  `placeAndAssignRequest` tests (or add focused ones) to assert a
  `recordStatusEvent` call with `toStatus:'assigned'` and the right `actorType`
  after a successful assignment.
- Full gate before commit: `tsc`, lint, tests green.

## Out of scope (YAGNI)
- Daily rollup tables (deferred scale path).
- Per-day sparklines / charts on the tiles (headline number + delta only for v1).
- CSV export (Reports already owns export; add later if asked).
- Real-time / live-dispatcher view (this is a daily-glance owner page).
- Configurable/custom date ranges beyond the three presets.
```
