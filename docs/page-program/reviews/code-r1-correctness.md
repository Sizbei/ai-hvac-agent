# Code review round 1 — correctness and regression

Scope: `git diff 7787352..HEAD -- src/ scripts/ drizzle/ tests/` (121 files,
+16,492/-295). Reviewed against `docs/page-program/PLAN.md`'s work items
(A1–A13, B1–B7, C1–C9, DC-1..4, W0-1/W0-2). Uncommitted working-tree changes
were ignored per instructions.

Method: read every changed production file in the diff, traced every changed
function's callers by grep/read (not just the diff hunk), cross-checked
comments' factual claims against the actual schema/code they described, ran
the touched test files plus the full suite, and ran `tsc --noEmit`.

Gate results (repo invariant: must not drop below 297 files / 4022 passed / 1
skipped):
- `npx tsc --noEmit` → 0 errors.
- `npx eslint <changed files>` → 0 errors (19 pre-existing-pattern warnings,
  e.g. `react-hooks/set-state-in-effect` on hooks written in this same style
  as untouched sibling hooks; not new regressions).
- `npx vitest run` (full suite) → **320 files / 4231 passed / 1 skipped**. No
  drop; +23 files / +209 tests over baseline.

## Findings

No blocker or major findings. Three minor/informational items below.

---

**CR-1** — severity: `minor` — tag: `verified`

`docs/page-program/LEDGER.md`'s "Wave A/B shipped" table is materially
incomplete relative to the actual committed diff, in the direction that makes
*more* work look undone than actually is. Confirmed present and correct in
the diff but **absent from the ledger's shipped list**: A12 (audit-log
cross-tenant join fix, `src/lib/admin/audit-queries.ts`), A13 (chat-history
verify gate, `src/app/api/chat/history/route.ts`), B4 (estimate terminal
state + link regeneration, `src/lib/admin/estimate-queries.ts`), B7
(`takePayment` post-claim state derivation, `src/lib/admin/invoice-queries.ts`),
C2 (operations metrics exclude synced jobs,
`src/lib/admin/operations-metrics-queries.ts`), C4 (11-phase FieldPulse import
+ stale-run detection, `src/components/admin/fp-import/import-status-model.ts`),
C5 (integration sync-health surfacing, `src/lib/admin/integrations-status.ts`),
C6 (portal history/draft-invoice/token fixes, `src/lib/portal/portal-queries.ts`),
and all four DC items (conversation reply UI, communications CRUD/delete
guard, tech tap targets).

This is not a code defect — every one of these landed correctly (see the
per-item checks below) — but a future session (or reviewer) trusting the
ledger's "not started" dashes for these rows would either re-do finished work
or wrongly report the program as less complete than it is.

Fix: append the missing rows to the "Wave A/B shipped" table in
`docs/page-program/LEDGER.md`.

---

**CR-2** — severity: `minor` — tag: `verified`

`src/components/admin/dispatch/map-pins.ts:107` hardcodes the geocode cap as
a literal in the chip copy:

```
return `${notPlottedCount} ${noun} couldn't be placed on the map (25-job geocoding limit reached)`;
```

The actual cap lives in `src/app/api/admin/dispatch/map/route.ts:27` as
`const MAX_GEOCODE = 25;` and is not exported or imported into `map-pins.ts`.
Today the two values agree, but nothing enforces that — a future change to
`MAX_GEOCODE` (e.g. raising it for a larger fleet) would silently leave the
UI copy wrong with no compiler or test signal (the existing
`map-pins.test.ts` only asserts the copy against the current literal, so it
would still pass with a stale number).

Fix: export `MAX_GEOCODE` from the route (or a shared constants module) and
interpolate it into `notPlottedChipMessage`, or pass it as a parameter.

---

**CR-3** — severity: `minor` — tag: `verified`

`src/app/api/admin/estimates/route.ts:100` — `await expireOverdueEstimates(session.organizationId)` —
runs synchronously and unconditionally on every `GET` of the estimates list,
adding a write-query round-trip to the read path's latency (on top of the
`Promise.all([listEstimates, getEstimatePipelineStats])` that follows it).
Functionally correct (B4's lazy-sweep design is sound, and the CAS-guarded
`UPDATE` is cheap when nothing is overdue), but it is the one place in this
diff that trades read latency for correctness without using the repo's
`after()` deferral pattern the rest of the codebase reaches for in this
situation (`AGENTS.md`: "Background work on Vercel: `after()`... never
detached promises"). Sweeping via `after()` isn't a direct fit here since the
freshly-swept rows are then read by the very same request (stats/list would
show stale `open` estimates if deferred) — so this isn't a straightforward
fix, but it's worth a comment noting the tradeoff was deliberate, and
revisiting if the estimates list becomes a hot path.

No fix required for this review; noted for awareness only.

---

## Notes on the explicitly-flagged risk areas

**`dashboardRequestSelect.assignedToName` (CASE WHEN `users.isActive`)** —
traced every consumer: `getDashboardOverview` (today's-schedule,
needs-attention, awaiting-follow-up — all three `.leftJoin(users, …)`),
`getDispatchBoard`, `getSchedulingCalendar` (day/week + unscheduled queue),
and `getMonthCalendar`. Every query site carries the required
`leftJoin(users, eq(serviceRequests.assignedTo, users.id))`, so the new
`CASE` expression never references an unjoined table. `users` is only ever
soft-deactivated (no code path hard-deletes a `users` row), so
`users.isActive` is never itself `NULL` for a non-null `assignedTo` — the
needs-attention `or(isNull(assignedTo), eq(users.isActive, false))` predicate
has no silent-NULL gap. Both UI consumers of `assignedToName`
(`request-table.tsx:85`, `dashboard-list-card.tsx:165`) already null-coalesce
to `'—'`/`'Unassigned'`. Dispatch board and calendar bucket by the raw
`assignedTo` id against an active-technicians-only map, so a job assigned to
a deactivated tech already fell into the "unassigned" pile pre-diff —
consistent with the new dashboard behavior, not contradicting it. Verified
against `queries.test.ts`'s new assertions and a live `vitest run`.

**`requiresVerify` / voice-channel possession-proof gate (A7 + A13)** —
`INTENT_SENSITIVITY` now gates all 8 account-touching intent ids (5
`account-data-*` plus 3 legacy aliases), confirmed against
`account-dispatch.ts`'s `LEGACY_ACCOUNT_INTENT_TOOL` map (the legacy ids
route to the identical tools). Traced both call sites —
`voice-turn.ts:379-438` and `chat/route.ts:790-990` — through every
`VerifyDecision` branch (`ask`/`defer`/`serve`) to confirm no dead end: a
caller who can never produce a matching ZIP (empty `onFileZips`, since
`checkZipMatch` can never match an empty array) hits `MAX_VERIFY_ATTEMPTS`
and lands on `VOICE_VERIFY_DEFER`/`CHAT_VERIFY_DEFER`, both of which end in
"I'll have our team follow up... anything else I can help with?" — a
graceful degrade, not a stuck loop. `voice-turn.test.ts`'s updated
regression tests exercise the real fixed behavior (a first `account-data-next-visit`
ask now challenges for ZIP; a correct ZIP then serves) rather than asserting
against mocks that would still pass on the old code. `A13`
(`chat/history/route.ts`) correctly reuses `parseVerifyState` +
`status !== 'passed'` to close the same unverified-link leak for the history
sidebar, consistent with A7.

**Money boundary logic** — `coalesce(issuedAt, createdAt)` in
`accounting-export.ts` uses the same `gte`/`lte` `fromDate`/`toDate` pattern
as every other date filter in that file (no new boundary asymmetry). The
estimates report's `dismissed` bucket addition
(`reporting-queries.ts`) is exhaustive and non-overlapping against the
DB-enforced 4-value `estimate_status` enum (`open`/`sold`/`dismissed`/`expired`,
`schema.ts:2626-2631`) — verified no double-count and a `closeDenominator > 0`
guard against division by zero. `expireOverdueEstimates`'s CAS-guarded sweep
correctly feeds the existing `BUCKET_CASE_SQL` `'lost'` bucket
(`status IN ('dismissed','expired')`), so `winRatePct` can now trend down as
B4 intended — confirmed by reading `getEstimatePipelineStats`'s SQL, not just
the diff comment.

**B7 (`takePayment` stale-read state, `invoice-queries.ts:246-260`)** — this
*is* in the diff (my first pass missed it in a stat listing; a second,
targeted `git diff` confirmed 26 changed lines). The fix correctly derives
`invoiceState` from the atomic claim's own `RETURNING` row
(`claimedInvoice.amountPaidCents >= claimedInvoice.totalCents`) instead of
the pre-claim `inv` snapshot, matching `reconcilePayment`'s existing pattern.
The added test
(`invoice-queries.test.ts`, "derives invoiceState from the POST-claim row,
not the pre-claim stale read (B7)") mocks the claim's `RETURNING` to reflect
a *different* value than the pre-claim read would predict and asserts on the
correct one — a genuine regression test, not tautological.

## Test-quality spot check

Sampled test additions across A2 (auth CSRF), A7/A13 (verify gate), A9/A11/A12
(dashboard/conversations/audit), B3/B4/B7 (reports/estimates/invoices), C1/C7/C8
(map/dispatch/calendar), and DC-1/DC-2 (conversation reply, communications
CRUD). All assert on behavior distinguishable from the pre-fix code (mocked
inputs/outputs are shaped so the old logic would produce a different,
wrong result), not on values the test itself just fed in. No tautological
tests found in the sample.

## Verdict

**Ship.** No blockers, no majors. The two areas called out as highest-risk in
this review's brief — the shared `dashboardRequestSelect` change and the
widened `requiresVerify` gate — are both correctly implemented, correctly
propagated to every consumer, and covered by tests that would fail against
the pre-fix behavior. Money/boundary logic (accounting date basis, estimate
bucket math, `takePayment` state derivation) is sound with no double-counting
or division-by-zero. All repo gates pass with margin (320/4231/1 vs. the
297/4022/1 floor). The three items above are housekeeping, not risk: update
the ledger (CR-1), and optionally de-duplicate the magic number in CR-2.
