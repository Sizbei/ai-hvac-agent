# Task 3 Report: Shadow mode — record would-be decision for autopilot-off orgs

**Status:** COMPLETE
**Commit:** `037266f` (on `main`)

## What shipped
Autopilot-OFF orgs now score + record the would-be dispatch decision (`is_shadow=true`) without ever touching `service_requests`; then first-fit runs byte-identically.

### Files
- `src/lib/ai/dispatch/signals.ts` — `loadDispatchSignals` gains `opts.skipRouting`; threaded to `loadTravelSignals`, which gates the `durationMatrix` (ORS) call on `!skipRouting && routingEnabled()`. Haversine km still computed.
- `src/lib/admin/scheduling-queries.ts` —
  - `recordDispatchDecision` gains `isShadow = false`; inserts `isShadow`; `candidates` JSONB now stores `skillMatched: r.skillMatched` per candidate (Task 6 reads it back).
  - `rankedTechnicianOrder` gains `skipRouting = false`, passed as `{ skipRouting }` to `loadDispatchSignals`.
  - `autoAssignBookedRequest`: new `if (!enabled)` shadow branch, placed AFTER the external-scheduler early return and `const enabled = ...`, BEFORE the `if (enabled)` booking-quality gate. Calls `rankedTechnicianOrder(..., false, true)` (auto-assign semantics: unclassifiable→null; skipRouting=true). If `shadow.ranked` non-null, `classifyDispatch` → `recordDispatchDecision(..., isShadow=true)` with the chosen tech only when `outcome==='committed'`. Unclassifiable → records nothing.
- Tests: `signals.test.ts` (skipRouting bypasses routing) + `scheduling-queries.test.ts` (2 shadow cases; insert mock now captures `.values()` payload).

## Invariants verified
- Shadow branch runs only when NOT external-scheduler AND autopilot disabled.
- SKIPS booking-quality gate (inside `if (enabled)`), SKIPS routing/ORS (skipRouting=true → durationMatrix never invoked).
- NEVER writes service_requests (no `stampDispatchOutcome`, no `placeAndAssignRequest`) — only inserts into `dispatch_decisions`.
- Unclassifiable jobs record nothing; first-fit continues unchanged after recording.

## Deviations from brief (necessary, in-scope)
1. **Added `dispatchDecisions` to the schema mock** in `scheduling-queries.test.ts`. Without it, `db.insert(dispatchDecisions)` threw "No dispatchDecisions export" (caught silently by `recordDispatchDecision`), so `insertMock` was never reached — the shadow assertion could never pass. The brief's insert-mock capture edit requires the insert to actually execute.
2. **Updated the pre-existing `disabled (default)` test** to push one unclassified classification row. The shadow branch now runs on the disabled path (it didn't before), so that test needed to feed the `loadJobClassification` read or its placement queue drifted. Kept the test's intent (unclassified → records nothing → first-fit T1 unchanged). Traces directly to the feature (disabled orgs now read classification for shadow).

## Evidence

### RED (before implementation)
```
FAIL scheduling-queries.test.ts > shadow: autopilot OFF but classifiable → ...
  AssertionError: expected { assigned: false } ... (insert not called)
FAIL scheduling-queries.test.ts > shadow: autopilot OFF and UNCLASSIFIABLE → ...
  AssertionError: expected { assigned: false } to deeply equal { assigned: true }
FAIL signals.test.ts > skips the routing call when skipRouting is set
  AssertionError: expected 12 to be null   (durationMatrix still called)
 Tests  3 failed | 61 passed (64)
```

### GREEN (after implementation)
```
 Test Files  2 passed (2)
      Tests  64 passed (64)
```

### Gate
```
$ npx tsc --noEmit
TSC_EXIT=0
$ npx eslint <4 files>
ESLINT_EXIT=0
```

## Queue-harness note
The brief's queue-feeding order matched the real select order (verified: `ensureEstimatedDuration`=1 select, `loadJobClassification`=1 select, `loadDispatchSignals` mocked/no-queue). No force-fitting needed — the only queue adjustment was feeding the classification read the shadow branch legitimately introduced into the disabled path.

## Concerns
- Commit landed on `main` (consistent with Tasks 1-2, which are also on `main`). If the intended target was `feat/tech-location-autodispatch`, cherry-pick `037266f`.
- Debug instrumentation was added then fully removed; verified no `console.error`/`SHADOW`/`RECORD CATCH` artifacts remain in source.

---

## Follow-up fix: shadow block exception safety (Task 3 shadow-mode follow-up)

**Status:** COMPLETE
**Commit:** `f6310fb` (on `feat/tech-location-autodispatch`)

### Finding
The `if (!enabled)` shadow block was not exception-safe: a transient DB error inside `rankedTechnicianOrder` (e.g. `loadJobClassification` or `loadDispatchSignals` rejecting) propagated out and broke the first-fit placement that follows.

### Fix
Wrapped the entire shadow block body in `try/catch`. On catch, logs via `logger.warn({ serviceRequestId, error }, "Auto-dispatch: shadow scoring failed, falling through to first-fit")` and falls through. No change to any other path.

**File:** `src/lib/admin/scheduling-queries.ts` — `autoAssignBookedRequest`, shadow `if (!enabled)` block.

### Test added
`src/lib/admin/scheduling-queries.test.ts` — "shadow: rankedTechnicianOrder throws → first-fit still places, no decision insert":
- Mocks `loadDispatchSignals.mockRejectedValueOnce(...)` to simulate the throw
- Asserts `result === { assigned: true, technicianId: T1 }`
- Asserts `insertMock` not called (no decision recorded)

### Gate outputs
```
$ npx tsc --noEmit
(no output — exit 0)

$ npx eslint src/lib/admin/scheduling-queries.ts
(no output — exit 0)

$ npx vitest run src/lib/admin/scheduling-queries.test.ts
 Test Files  1 passed (1)
      Tests  52 passed (52)
   Duration  713ms
```
