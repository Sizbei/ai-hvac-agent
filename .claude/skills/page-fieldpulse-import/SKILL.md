---
name: page-fieldpulse-import
description: Use when working on the /admin/fieldpulse-import page — live import progress dashboard for the FieldPulse full-import pipeline (11 phases: technicians, customers, jobs, invoices, estimates, payments, assets, comments, locations, items, job-metrics).
---

# FieldPulse import (/admin/fieldpulse-import)

**Purpose:** observe the status of the FieldPulse full-import pipeline in real
time. Shows per-phase progress cards (all 11 pipeline phases) and a
recent-runs history table. Platform users only: the server page gates on
`seesPlatformUi(viewer)` (in-shell 404 otherwise, and while previewing) and the
status API on `isPlatformAdmin(session)` (404). Auto-polls while any phase is
actively running.

**Files:** page (server gate) `src/app/admin/(dashboard)/fieldpulse-import/page.tsx` ·
board `src/components/admin/fp-import/fieldpulse-import-board.tsx` · model
`src/components/admin/fp-import/import-status-model.ts` · hook
`src/hooks/use-fp-import-status.ts` · API
`src/app/api/admin/integrations/fieldpulse/import-status/route.ts` · table
`fp_import_runs`

**Data flow:** `useFpImportStatus` polls
`/api/admin/integrations/fieldpulse/import-status` at a variable interval while
at least one run has `status === 'running'`; polling stops automatically and
a manual Refresh button appears when idle. `latestRunPerPhase` in the model picks
the newest run per phase from the flat `fp_import_runs` rows. Progress percentage
(`progressPct`) is derived from counts (fetched vs expected); when the count is
unknown it renders an indeterminate pulse bar.

**Invariants:**
- Pipeline order is fixed: `PIPELINE_PHASES` in `import-status-model.ts` — the
  real 11-phase pipeline (`technicians`, `customers`, `jobs`, `invoices`,
  `estimates`, `payments`, `assets`, `comments`, `locations`, `items`,
  `job-metrics`), mirroring `PHASES` in
  `src/lib/integrations/fieldpulse/import/run-import.ts`. This is the ONLY
  copy of the phase list — the page imports it rather than hand-maintaining a
  second array; a second copy is exactly how the page used to show only 4 of
  11 phases. Phase cards always render in this order regardless of which
  phases have runs.
- **Stale-run detection:** a row still `status: 'running'` whose `startedAt`
  is older than `STALE_RUN_THRESHOLD_MS` (3h, comfortably past the nightly
  GitHub Actions job's 150-minute timeout) is treated as abandoned, not
  active — `run-import.ts` has no SIGINT/SIGTERM handler, so a killed process
  leaves its row `running` forever. `isStaleRun` is pure and display-only (no
  DB write); it also feeds `nextPollDelay`, so a stale "running" row stops
  polling and the Refresh button reappears — without this fix the page would
  poll a dead run forever.
- `asOfMs` (captured at each fetch) is what `isStaleRun` compares against —
  never call `Date.now()` directly during render (React purity rule);
  components must receive `asOfMs` as a prop.
- `ElapsedTime` uses a 1 s `setInterval` while `isRunning`; the interval is
  cleaned up in the effect's return. Do not move elapsed formatting outside this
  component — it must tick live.
- Status chip colors follow token classes only (`bg-info-light`, `bg-success-light`,
  `bg-danger-light`, `bg-muted`) — no raw palette.
- Import runs are observability-only; no mutations happen from this page.
  Triggering an import is a separate admin/API operation.
- `fp_import_runs` is org-scoped; the API gates on `organizationId` from the session.

**Gotchas:**
- When polling is active the Refresh button is hidden; it reappears when polling
  stops (idle state). Never show both at once.
- `run.error` is raw internal text (FieldPulse API errors, stack traces); the
  card shows fixed human copy (`RUN_FAILED_COPY`), never the stored string.
- `counts` is typed as `FpRunCounts` but stored as JSONB — cast required at
  read sites.

**Verify changes:** `npx vitest run
src/components/admin/fp-import/import-status-model.test.ts
src/hooks/use-fp-import-status.test.ts` · visual via the admin-pages recipe at
`/admin/fieldpulse-import` · confirm all 11 phase cards render even with no
runs ("No runs yet" placeholder state).
