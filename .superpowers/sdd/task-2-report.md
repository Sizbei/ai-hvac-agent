# Task 2 Report: Override telemetry — shared stamp helper + actingUserId plumbing

**Status:** DONE_WITH_CONCERNS
**Commit:** `712b6d5` feat(dispatch): override telemetry — stamp human pick on decision row
**Branch:** `main` (parent = Task 1's `4ecbb96`, migration 0041)

## What shipped
- Created `src/lib/admin/dispatch-override.ts` — `stampDispatchOverride(orgId, requestId, humanTechnicianId, actingUserId)`:
  latest REAL decision row lookup (`is_shadow=false`, `created_at DESC LIMIT 1`), JS early-return when
  `chosenTechnicianId === humanTechnicianId`, tenant-scoped UPDATE with `IS DISTINCT FROM` SQL guard, best-effort
  try/catch that logs + swallows (never throws).
- Created `src/lib/admin/dispatch-override.test.ts` — 5 tests (stamps-on-differ, no-op-on-shadow, no-op-on-equal,
  no-op-on-no-row, swallows-write-failure).
- `src/lib/admin/queries.ts` — added optional `actingUserId?` 4th param to `assignTechnician` + `reassignTechnician`;
  stamp block (guarded on `actingUserId`) after each successful mutation.
- `src/lib/admin/scheduling-queries.ts` — added `readonly actingUserId?: string` to `placeAndAssignRequest` options;
  stamp block after the `isFirstAssignment` event, before the override recompute.
- Routes: `assign/route.ts` POST+PATCH pass `session.userId`; `reschedule/route.ts` passes `actingUserId: session.userId`.

## DEVIATION FROM BRIEF (the concern)
The brief's Step 5 stamp block used `options.technicianId!` as the human pick. But `technicianId` is **optional** in
`placeAndAssignRequest` / the reschedule route (a pure reschedule keeps the current assignee and passes no
`technicianId`). The brief's code would have called the helper with `humanTechnicianId = undefined` on any pure
reschedule — stamping a garbage/undefined label.

I substituted the already-computed `targetTech` (`resolveTargetTech(options.technicianId, existing.assignedTo)` =
new tech on reassign, retained assignee on pure reschedule, `null` when unassigned) and guarded the stamp on
`options.actingUserId && targetTech`. This:
- labels the human's effective final pick correctly on both reassign and pure-reschedule-of-an-assigned-job,
- never stamps `undefined`,
- never stamps an unassigned placement (nothing to label) — consistent with the brief's intent ("a HUMAN
  drag/placement that (re)assigned the tech"),
- still does NOT require `reassigning` (first-time human placements still label), per the brief.

Everything else matches the brief and the verified real signatures verbatim. Narrow, well-understood correctness
fix — flagging for reviewer awareness.

## TDD evidence (actual output)

### RED (Step 2) — before helper existed
```
 FAIL  src/lib/admin/dispatch-override.test.ts [ src/lib/admin/dispatch-override.test.ts ]
Error: Cannot find module '/src/lib/admin/dispatch-override' imported from .../dispatch-override.test.ts
 ❯ src/lib/admin/dispatch-override.test.ts:69:1
     69| import { stampDispatchOverride } from "./dispatch-override";
 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN (Step 7) — new + existing scheduling suite
```
 Test Files  2 passed (2)
      Tests  54 passed (54)
```
(dispatch-override.test.ts = 5 tests; scheduling-queries.test.ts unaffected.)

### Gate (Step 8)
`npx tsc --noEmit` → `TSC_EXIT=0`
`npx eslint <6 changed files>` → `ESLINT_EXIT=0`

Note: three tsc errors surfaced in the brief-verbatim "swallows a write failure" test block
(`throwingChain` self-reference implicit-any + the `db` cast overlap). Fixed test-only with explicit
`unknown` annotations (`const throwingChain: unknown = ...`, `... as unknown as { update: () => unknown }`);
behavior unchanged, test still passes.

## Invariants honored
- Latest-row lookup filters `is_shadow=false` (test asserts `dd.shadow` present in read conditions).
- Stamp only when chosen IS DISTINCT FROM human pick (JS early-return + SQL guard).
- Last-write-wins on re-override (unconditional overwrite of the three fields).
- Best-effort: failure caught + `logger.error`, never throws (test asserts `resolves.toBeUndefined()`).
- Background auto path passes no `actingUserId` → never stamps.
- Tenant-scoped on both read and write.
