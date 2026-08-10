# dispatch — target-state spec

`/admin/dispatch` — the day-level dispatch board with confidence-gated
autopilot, shadow mode, and the exceptions rail.

## 1. Purpose

Give a dispatcher one screen to see and place every request for a single
business day: a column per active technician, an unassigned pile, and an
exceptions rail for jobs auto-dispatch couldn't confidently place. The
dispatcher's click is always the final word — autopilot may pre-place a
clear-winner job, but every commit is explainable ("why this tech?") and every
human override is the ground-truth label the scoring loop learns from.

## 2. Brainstorm

Phases 1-3 of `docs/DISPATCH.md`'s sequenced plan already shipped (override
telemetry, shadow mode, outcome rollup+canary, decision panel, exceptions
rail, chain/recency/duration-fit scoring). The bar for new work here is high;
Phase 4/5 items (weight tuning, routing A/B, geofenced auto-status, skill
matrix, fairness term, route optimization) are data-gated or structural bets
explicitly deferred by that plan — not reconsidered.

- **Fix the `OUTCOME_LABELS` dead map** — worth doing, see Gdispatch-1.
  Rejected alternative: leave it. It silently mislabels every exception
  badge today; the fallback formatter masks it well enough to read as
  cosmetic, but it's evidence the map was never updated when real outcome
  codes shipped (the page skill's own gotcha admits this — nobody did it).
  Small, mechanical.
- **Drag-and-drop between columns** — rejected. Dispatch is triage/placement
  (`assign`/`decision`, no arrival-window param); drag-to-schedule already
  exists on `/admin/calendar` via `placeAndAssignRequest`. Duplicating that
  surface and its conflict/availability gate here buys nothing. inferred.
- **A "commit rate" gauge on the board** — rejected. Already lives on
  `/admin/operations` as the "Dispatch health" card (`docs/DISPATCH.md:221-239`)
  — a second copy here would be a second source of truth.
- **One-click accept directly on exception rail rows** — rejected.
  `docs/DISPATCH.md:264-274` deliberately routes exception clicks through the
  detail sheet, which already has one-click assign via the suggest card.
- **Filter/search on the board** — rejected. One day, typically a handful of
  technician columns; no complaint or data supports a filter bar. YAGNI.
- **Faster than 30s polling** — rejected. `use-dispatch-board.ts:27` polls
  30s with an equality guard; acting on a job triggers an immediate
  `onAssigned={refetch}`, not poll-dependent. Tightening buys nothing.
- **Surface shadow "would-be" outcomes inline on cards for autopilot-off
  orgs** — rejected. Would blur the "autopilot is OFF" mental model shadow
  mode deliberately preserves. The decision panel already surfaces it,
  labeled "preview", on click — sufficient and opt-in.

## 3. Current state

**Board fetch.** `GET /api/admin/dispatch?date=` (`api/admin/dispatch/route.ts:15-46`,
verified) session-gates, rate-limits, runs `getDispatchBoard` +
`getDispatchExceptions` in parallel. `useDispatchBoard`
(`src/hooks/use-dispatch-board.ts:35-110`, verified) polls 30s with a
monotonic run-id guard (stale responses discarded, `:50,54`) and a JSON-
equality guard against needless repaint (`:71-76`).

**Board query.** `getDispatchBoard` (`src/lib/admin/queries.ts:1280-1347`,
verified) anchors on the BUSINESS day (`businessDayBounds`/`businessIsoDate`,
not UTC), seeds one bucket per ACTIVE technician first (`:1320-1323`), then
buckets jobs by `assignedTo`; a job whose assignee doesn't match an active
bucket (e.g. deactivated) falls to `unassigned` rather than disappearing
(`:1328-1333`, verified — matches the page skill's invariant).

**Assignment.** `POST /api/admin/requests/[id]/assign`
(`assign/route.ts:18-96`, verified) UUID-validates, rate-limits, session-
gates, calls `assignTechnician(orgId, id, technicianId, session.userId)`.
`assignTechnician` (`src/lib/admin/queries.ts:472-570`, verified): (1) verifies
the assignee is an ACTIVE technician in THIS org (`:480-497`); (2) a status-
guarded `UPDATE ... WHERE status IN ASSIGNABLE_STATUSES` (`:437`) closes the
lost-update race between two dispatchers — a concurrent second assign
matches zero rows (`:512-529`); (3) records a status event (`:544-552`), then
best-effort stamps override telemetry when `actingUserId` is present
(`:578-585`). `PATCH` (reassign, in-flight jobs) mirrors this via
`reassignTechnician` (`:604-...`, verified), gated on `REASSIGNABLE_STATUSES`
(`:460`) and also stamping override telemetry (`:672-681`).

**Override telemetry.** `stampDispatchOverride`
(`src/lib/admin/dispatch-override.ts:26-85`, verified) looks up the request's
latest **real** (`isShadow=false`, `:48`) decision row, no-ops if the human's
pick matches autopilot's (`:57`, so a non-override is never mislabeled), else
stamps `overriddenTechnicianId/overriddenByUserId/overriddenAt` guarded by
`IS DISTINCT FROM` (`:74-76`, defense-in-depth against a concurrent stamp).
Try/catch-wrapped — a telemetry failure never fails the assignment (`:79-84`).

**Auto-assign / confidence gate (server-side).** `autoAssignBookedRequest`
(`src/lib/admin/scheduling-queries.ts:1239-1459`, verified) runs on the
booking's `after()` path. `classifyDispatch`
(`src/lib/ai/dispatch/score.ts:285-303`, verified) requires
`gap = top.score - second.score >= MIN_CONFIDENCE_GAP` (0.08, or 0.02 for
`urgency==="emergency"`, `:271-276,296-298`) to commit; anything else returns
a `queued_*` outcome and the caller stamps it WITHOUT calling
`placeAndAssignRequest` (`:1363-1373`, verified). No client-side confidence
logic exists anywhere in the dispatch page/hook/components (grepped
`.../dispatch/page.tsx`, `.../dispatch/dispatch-column.tsx`,
`use-dispatch-board.ts` — no score/gap/threshold code present, verified).

**No-double-assign.** `assignedTo` is a single nullable FK (structurally one
technician). Background auto-dispatch passes `requireUnassigned: true` into
`placeAndAssignRequest` (`scheduling-queries.ts:594-597,742-745`, verified),
adding `assignedTo IS NULL` to the guarded UPDATE so a human's calendar drag
made during the multi-second scoring window can't be clobbered — the UPDATE
matches zero rows and the loop tries the next candidate (`:1439-1444`). A
concurrent double-book of the SAME tech's time is separately blocked by the
`noDoubleBookGuard` NOT-EXISTS subquery folded into the same UPDATE
(`:714-727`, verified).

**Shadow mode never writes a real assignment.** The `!enabled` branch in
`autoAssignBookedRequest` (`:1299-1328`, verified) only calls
`recordDispatchDecision(..., isShadow=true)` (`:1311-1320`) — never
`stampDispatchOutcome` or `placeAndAssignRequest`. It skips the booking-
quality gate (`:1294-1296` comment + no call present) and passes
`skipRouting=true` (`:1307`, haversine-only, no ORS spend).
`dispatchDecisions.isShadow` (`src/lib/db/schema.ts:2489`, verified) is
either structurally unreachable by the exceptions rail (`dispatch-
exceptions-queries.ts` reads only `service_requests`, never
`dispatchDecisions`) or labeled — `getDispatchDecisionForRequest` returns
`isShadow` verbatim (`dispatch-decision-queries.ts:47`) and the sheet renders
a "preview" indicator (`request-detail-sheet.tsx:971`, verified).
`stampDispatchOverride` also excludes shadow rows (`dispatch-override.ts:48`,
verified) so a human pick can't attach to a preview-only row.

**Scoring degrades gracefully.** `signals.ts` seeds a zeroed/null default row
for every requested tech BEFORE any query runs (`src/lib/ai/dispatch/
signals.ts:118-133`, verified), so a tech with zero history still scores.
Travel: `travelKm`/`travelMinutes` start null and populate only when the job
has cached coords AND a tech anchor exists (`:427-428,441-450`);
`scoreTechnician` documents "when null the score is byte-identical to the
no-travel composite" (`score.ts:36-37`), confirmed by the branch structure
(`:139-162`) — the neutral-travel blend only activates when some OTHER
candidate has a location (`:108-111,155-162`), so an unlocated tech is
neither starved nor unfairly boosted. This is the exact failure mode the repo
hit for real — geocode data was once entirely empty before the 2026-07
backfill (user memory `map-geocode-and-invoice-tax`) — load-bearing, not
theoretical. Availability: `sumAvailabilityMinutes([])` returns the bounded
`DEFAULT_DAY_MINUTES=720` default, not 0 (`score.ts:83-96`, verified), so a
tech with no availability rows isn't flagged "day full" from minute one.

**Exceptions rail.** `getDispatchExceptions`
(`src/lib/admin/dispatch-exceptions-queries.ts:26-60`, verified) is
deliberately day-independent (no `businessDayBounds` filter) so a queued job
from yesterday doesn't scroll out of sight. Filters `isNull(assignedTo)` +
`like(autoDispatchOutcome, 'queued_%')` + non-terminal status, oldest-first,
capped 20 (`:44-50`). Rendered only when `board.exceptions.length > 0`
(`dispatch/page.tsx:124-153`, verified — absent, not empty-stated, matching
the page skill's documented gotcha).

**Decision panel.** `GET /api/admin/requests/[id]/decision`
(`decision/route.ts:18-48`, verified) → `getDispatchDecisionForRequest`
(`dispatch-decision-queries.ts:40-104`, verified) reads the latest row
(`:65-66`), resolves candidate names with one org-scoped `inArray` lookup
(`:73-79`, no N+1), reads `skillMatched` from the STORED field rather than
re-deriving from reason text (`:88-89`). Rendered as a collapsible section
in `request-detail-sheet.tsx` (`:956,971,977,983-989`, grep-verified),
fail-open on fetch error (`:539-554`).

**Outcome label map is stale.** `OUTCOME_LABELS`
(`src/app/admin/(dashboard)/dispatch/page.tsx:36-41`, verified) hardcodes
`queued_no_capacity`, `queued_low_confidence`, `queued_after_hours`,
`queued_no_match`. The real `DispatchOutcome` union
(`src/lib/ai/dispatch/score.ts:261-265`, verified) is `committed |
queued_ambiguous | queued_no_fit | queued_needs_review` — zero overlap with
the map's keys. Every real badge falls through to the generic fallback
(`outcomeLabel`, `:43-45`, strips prefix/underscores) — e.g.
`queued_ambiguous` → "ambiguous". Reads fine in English, which is why it
shipped unnoticed; the map itself is dead code. See Gdispatch-1.

**Test coverage exists** for exceptions, decisions, override, rollup, score,
and signals (`*.test.ts` files found via `find`, 2026-08-11); not read
line-by-line for this spec.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gdispatch-1: `OUTCOME_LABELS` maps four outcome codes that don't exist in `DispatchOutcome`; every real code falls through to the fallback formatter | P2 | `page.tsx:36-41` vs `score.ts:261-265` — zero key overlap, verified |
| Gdispatch-2: no test directly asserts "shadow never writes `service_requests`" (coverage today is by code-reading, not a regression test that would catch an accidental future write added to the `!enabled` branch) | P2 | `scheduling-queries.ts:1299-1328` — no test file targets this branch specifically among the six dispatch test files found; inferred from listing, not exhaustive test-body read |
| Gdispatch-3: board-card time display forces `timeZone: 'UTC'` (`dispatch-column.tsx:29-33`) while the board is bucketed by BUSINESS (Eastern) day — a card's displayed hour can read differently from the Eastern wall-clock the bucketing implies | P2 | `dispatch-column.tsx:25-34` vs Eastern-anchored `businessDayBounds` (`queries.ts:1280-1288`) — inferred (display-only; not confirmed against a live example this session) |

No P0 or P1 gaps found. The four target lenses (auto-assign invariant,
shadow-mode isolation, graceful degradation, telemetry correctness) all
checked out — see Current state for the trail. Consistent with
`docs/DISPATCH.md:127-133`'s own accounting that Phases 1-3 shipped and were
reviewed; this session's independent code read corroborates that.

## 5. Requirements

Per METHOD.md's severity gate (only P0/P1 gaps become requirements) and the
finding that none exist, there are no requirements here — the three P2
items stay in the Gaps table and the backlog.

## 6. Non-goals

- **Drag-and-drop scheduling on this page** — `/admin/calendar`'s job
  (`placeAndAssignRequest`); dispatch is assign/reassign triage only.
- **Weight/threshold tuning** (`MIN_CONFIDENCE_GAP`, `W_TRAVEL`, …) — Phase 4,
  data-gated on ~2-4 weeks of pilot traffic (`docs/DISPATCH.md:319-321`).
- **Routing A/B verdict, geofenced auto-status, explicit skill matrix,
  fairness term, route optimization, real-time re-dispatch, learning loop**
  — Phase 4/5 structural bets (`docs/DISPATCH.md:322-338`), out of scope.
- **A board-level metrics/rollup widget** — already lives on
  `/admin/operations`; not duplicated here.

## 7. Invariants

Inherited from `.claude/skills/page-dispatch/SKILL.md` and
`.claude/skills/admin-pages/SKILL.md`, restated with why each matters:

- **Business-day anchoring** — buckets by `businessIsoDate` (Eastern), not
  UTC; breaking this puts the evening board on tomorrow after 8pm ET
  (verified `queries.ts:1284-1288`).
- **Deactivated-assignee jobs fall to unassigned, never disappear** — the
  seed-active-first bucketing (`queries.ts:1320-1333`) makes this true.
- **Shadow rows never commit** — `is_shadow=true` must never cause a
  `service_requests` write (verified `scheduling-queries.ts:1299-1328`);
  breaking it would make an autopilot-OFF org silently start assigning jobs.
- **Auto badge only on true auto-assignments** — `markAutoAssigned` is
  guarded on the assignee just placed (`scheduling-queries.ts:1094-1112`).
- **Suggest is advisory-only** — `suggestTechnicians` never calls
  `placeAndAssignRequest`; the human's assign click is always the commit
  (verified `suggest/[id]/route.ts:18`).
- **Override telemetry never stamps a shadow row** — `dispatch-override.ts:48`;
  breaking it would poison the tuning dataset with preview-only labels.
- **`requireUnassigned` on the background path** — auto-dispatch can never
  overwrite a human's manual assignment made during scoring
  (`scheduling-queries.ts:594-597`).
- **Confidence gate is server-side** (no client code checks the score gap)
  and **tenancy** — every query here is `withTenant`-scoped by `session.organizationId`.
- **`OUTCOME_LABELS` maintenance** — the page skill's stated invariant ("add
  entries when new outcome codes are introduced") is currently violated
  (Gdispatch-1) but still holds as the reason to fix it.

## 8. Verification

No requirements were generated, so nothing new to build or verify this run.
For a future pass picking up a Gdispatch-* item:

- Gates: `npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 · `npx vitest run`
  → must not drop below the baseline in `docs/page-program/README.md`.
- Re-run untouched: `npx vitest run src/lib/admin/dispatch-exceptions-queries.test.ts
  src/lib/admin/dispatch-decision-queries.test.ts src/lib/admin/dispatch-override.test.ts
  src/lib/admin/dispatch-rollup.test.ts src/lib/ai/dispatch/score.test.ts
  src/lib/ai/dispatch/signals.test.ts`.
- Visual: mint a session, `node scripts/agent/screenshot-page.mjs
  /admin/dispatch`; create an unassigned request, confirm it lands in
  Unassigned, assign it, confirm it moves and the exceptions rail updates.
- If Gdispatch-1 is picked up: force each real `queued_*` outcome in a dev
  seed and screenshot the rail badge text, confirming it reads from the
  corrected map, not the fallback.
