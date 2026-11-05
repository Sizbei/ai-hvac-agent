---
name: page-reports
description: Use when working on the /admin/reports page — revenue, AR, estimate close rate, lead-source ROI, location breakdown, and technician scorecards with date-range presets.
---

# Reports (/admin/reports)

**Purpose:** operator sales dashboard — period revenue, outstanding AR, estimate close
rate, lead-source ROI, per-location job/revenue/rating rollup, and per-technician
scorecards. Date range is preset-driven (30 / 90 / 365 days).

**Files:** page `src/app/admin/(dashboard)/reports/page.tsx` · hook
`src/hooks/use-reports.ts` · API `src/app/api/admin/reports/route.ts` · query lib
`src/lib/admin/reporting-queries.ts` · tables `service_requests`, `estimates`,
`invoices`, `payments`, `refunds`, `technician_assignments`, `reviews`

**Data flow:** `useReports(range)` holds a 60 s client-side SWR cache
(`createSwrCache`). On range change `range` is memoized — a plain `new Date()` each
render would refetch on every render cycle. The API calls `db.batch([…])` for
all sub-queries in a single round-trip. Synced (FieldPulse / HCP) invoices
contribute `syncedCollectedCents` to net revenue but carry no native payment rows;
the revenue tile shows the breakdown in its sublabel.

**Invariants:**
- Null metrics render `—`, never a misleading `0` (`EMPTY` constant, `formatRating`,
  `formatHours` helpers).
- All three breakdown tables sort locally by `revenueCents` desc with spread-copy
  immutable sort — never mutate the hook's array directly.
- Money formatting: always `formatCentsExact` from `src/lib/admin/money-format`.
  No raw currency arithmetic in the component.
- `closeRatePct` denominator is `estimatesSold + estimatesOpen + estimatesExpired
  + estimatesDismissed` — the 4 estimate statuses sum to `estimatesCreated`
  with nothing silently vanishing. `dismissed` is a real decided "lost"
  outcome (matches `/admin/estimates`' bucket classifier, which groups
  `status IN ('dismissed','expired')` as 'lost') and must always be counted —
  do not drop it back to `open + sold + expired`.
- Location and technician table sublabels disclose that revenue is billed
  (invoiced), not cash collected — do not let that copy drift back to a bare
  "revenue" that implies collected cash.

- Rates with a zero denominator render `—` (`formatRate` in
  `src/lib/admin/report-format.ts`): the close-rate tile when no estimates
  exist, a lead-source row with 0 leads. The query still returns 0; the page
  owns the dash.
- Lead sources with no leads, bookings or revenue are hidden
  (`visibleLeadSources`); all hidden → the empty state.
- Location names come from `locationDisplayLabel`: label → zone → first line
  of the decrypted address → "Address not on file" ("Erased address" for an
  erased one). Never the bare word "Location". Only locations with jobs in
  the period are decrypted.
- Phone layout: secondary columns (Booked, Avg rating, Labor) use
  `hidden sm:table-cell`; card explanations go in SectionCard `description`,
  never in `action`/`meta` (that squeezed titles to nothing on phones).

**Gotchas:**
- The range `useMemo` dependency is `[days]`, not the `Date` objects. Removing the
  memo causes an infinite refetch loop.
- Synced AR (`syncedArCents`) may be 0 if no FSM integrations are configured;
  the sublabel conditionally shows the split only when `syncedArCents > 0`.
- `TechnicianScorecardRow.technicianId` is nullable (unassigned requests); the
  `getRowKey` falls back to `'unassigned'`.

**Verify changes:** `npx vitest run src/lib/admin/reporting-queries` ·
visual via the admin-pages recipe at `/admin/reports`.
