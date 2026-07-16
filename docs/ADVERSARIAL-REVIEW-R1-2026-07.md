# Adversarial Review — Round 1 (2026-07-16)

Five parallel auditors (regression, forms/mutations, data-reconciliation, scheduling/AI, + a fixer) over all admin pages, code + **live** probing on the dev branch. Regression pass: **13/17 prior fixes confirmed correct**. Reconciliation: **all headline AR/counts reconcile across surfaces** ($166,946 AR consistent). New findings below; already-fixed (commit `347a0f6`): suggested-tech fallback, invite-revoke gating, P3 sweep.

## BLOCKERS (verified-live)
- **B1 · Double-submit → duplicate records** (all dialogs). `setIsSubmitting` state is racy; 2 rapid clicks create 2 rows (proven live). → synchronous `useRef` in-flight guard in each dialog.
- **B2 · Malformed JSON body → 500** on every mutation route (`request.json()` throws, caught as 500). → wrap in try/catch → `400 VALIDATION_ERROR`. Model: staff/invites routes already do this.
- **B3 · Duplicate pricebook SKU → 500** not 409 (partial unique index slips past `isUniqueViolation` code==23505). → also match constraint name in message / pre-check.
- **B4 · `memberPriceCents > priceCents` accepted** → member overbilling. → Zod `.refine(member ≤ standard)` on pricebook POST+PATCH + client guard.

## HIGH
- **H1 · Audit-log money-value leak (incomplete fix)** — 4 remaining writers still emit values: `payments/[id]/refund` (amountCents), `invoices/[id]/payments` (amountCents), `financing` (amountCents), `pricebook`/`membership-plans` create (priceCents). → strip values, keep ids/enums/states.
- **H2 (data) · 2 FP invoices `state=paid` but `amount_paid_cents=0`** ($580 mis-shown as balance). → importer: on paid state set amountPaid=total; note prod backfill needs FP key.

## MAJOR
- Shared `isFetchingRef` race (calendar/dispatch/conversations hooks): rapid nav/filter drops the fetch → stale data until next poll. → per-fetch AbortController / sequence number.
- Windowless `assigned`/`in_progress` jobs invisible on board + calendar sidebar. → extend `listUnscheduledRequests`.
- OpsInsights error unrecoverable (no retry; page Refresh doesn't refetch it). → retry button + setError(null) on retry.
- Shadow route `/api/admin/service-requests/[id]/reschedule` — dead but live, UTC-naive, never writes arrival window. → delete (active path is `/requests/[id]/reschedule`).
- Customer `name` no max-length (10k stored); POST `propertySqft` no guard (negative stored / overflow→500). → cap name ≤200, guard sqft like `update_contact` does.
- `parseDollarsToCents("1e10")` → $10B item (no cap). → cap output + server `priceCents` max.
- Estimate `expiresInDays="abc"|"0"` → silent never-expires. → validate 1–365.
- `update_contact` blank name → 200 no-op (contract wrong). → 400.
- Ghost write: closing a dialog mid-submit still creates the record silently. → block close while submitting.
- Estimate-create error rendered below the scroll fold. → move error to top.
- Staff dialog still offers "Super Admin" though the route now rejects it (self-inflicted divergence). → drop the option.

## MEDIUM / regression follow-ups
- Fix 3 (minCents/maxCents) silently DROPS the filter on out-of-range (shows all as if filtered) + no cross-field check. → 400 on out-of-range/contradictory.
- Fix 11e `lastServiceDate` uses `max(createdAt)` not `max(completedAt)` (list + detail). → completedAt.
- Fix 8 deactivate: network-failure path uncaught (silent no-op). → try/catch.
- Overdue predicate differs: invoice SummaryBand (1-day grace/30-day) vs ops-metrics (`<NOW()`). → shared predicate.
- `arAging.totalOutstandingCents` is native-only ($4,589) — misleading name. → rename `nativeOutstandingCents`.
- `customer-profile.ts` / `dispatch-map` balance COALESCE/positivity guards (latent, $0 today).

## MINOR / LOW
- 429s lack `Retry-After`; map `fmt(25)="13pm"` for 11pm window (add `%24`); map two corner chips overlap; `score.ts` quality unclamped if avgRating>5; `toScheduledJob` returns "" not null (type lie); unschedule calls onRefetch after rollback; staff GET no rate limit; `markupPct` no max; settings/conversation-limits `setSaving` not in finally; settings errors at page-top not per-panel.

## Confirmed-correct (do not touch): isUuid guards, GROUP BY fixes, accounting or(fp,hcp), businessDayBounds `!`, map ET times (midnight safe), 5000-cap, KeyboardSensor, RoleBadge, use-reports latest-wins, calendar localStorage useEffect (hydration-safe — do NOT revert to lazy useState), DST handling, month-view overflow, double-book 409 rollback.

## Execution: F1 routes-hardening · F2 dialogs · F3 hooks-race+insights · F4a audit+AR-consistency · F4b scheduling/map/misc → verify → deploy.
