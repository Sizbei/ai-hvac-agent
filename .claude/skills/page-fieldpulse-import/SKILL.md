---
name: page-fieldpulse-import
description: Use when working on the /admin/fieldpulse-import page — live import progress dashboard for the FieldPulse full-import pipeline (technicians → customers → jobs → invoices).
---

# FieldPulse import (/admin/fieldpulse-import)

**Purpose:** observe the status of the FieldPulse full-import pipeline in real
time. Shows per-phase progress cards (technicians, customers, jobs, invoices)
and a recent-runs history table. Auto-polls while any phase is running.

**Files:** page `src/app/admin/(dashboard)/fieldpulse-import/page.tsx` · model
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
- Pipeline order is fixed: `['technicians', 'customers', 'jobs', 'invoices']`.
  Phase cards always render in this order regardless of which phases have runs.
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
- `run.error` may be a long stack trace string; `break-words text-xs` on the error
  paragraph prevents horizontal overflow. Keep those classes.
- `counts` is typed as `FpRunCounts` but stored as JSONB — cast required at
  read sites.

**Verify changes:** visual via the admin-pages recipe at `/admin/fieldpulse-import`
· confirm phase cards render even with no runs ("No runs yet" placeholder state).
