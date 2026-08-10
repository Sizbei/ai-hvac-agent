# fieldpulse-import — target-state spec

`/admin/fieldpulse-import` — live status dashboard for the FieldPulse
full-import pipeline.

## 1. Purpose

Let an admin operator see, at a glance, whether the FieldPulse import
pipeline (the nightly full sweep + any manual `npm run fp:import` run) is
healthy: which phases ran, whether they're still running, what they
processed, and whether anything failed — without reading server logs or
querying the database directly. One job: turn `fp_import_runs` rows into a
trustworthy operational picture. This page never mutates data — it is
read-only observability (`.claude/skills/page-fieldpulse-import/SKILL.md:34-35`,
verified against `src/app/admin/(dashboard)/fieldpulse-import/page.tsx` — no
`POST`/mutation call anywhere in the component tree).

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Poll while a run is active, stop when idle** — shipped
  (`use-fp-import-status.ts:29-32,63-88`). Rejected alternative: WebSocket/SSE
  push. Reason: the sweep runs for minutes, not milliseconds; a 2.5s poll is
  imperceptibly different from push for this cadence, and Vercel serverless
  doesn't hold long-lived connections well. Not worth the infra.
  verified.
  \n
- **Cover the real 11-phase pipeline, not a hardcoded 4** — this spec adds it
  (Gfieldpulse-import-1). The page currently only knows about
  technicians/customers/jobs/invoices; the actual pipeline run nightly is 11
  phases (Brainstorm rejects nothing here — this is a straight gap fix).
- **Stale-run detection (display-only)** — this spec adds it
  (Gfieldpulse-import-2). Considered vs. a "cancel run" mutation button.
  Rejected the mutation button: the page's own invariant is
  observability-only, no writes (skill:34-35); a cancel button would race the
  importer's own 2s flush-interval write (`run-import.ts:412-418`) and could
  falsely mark a still-alive process as cancelled. A pure "this looks stale"
  badge, computed client-side from `startedAt`, needs no new write path and
  can't lie about DB state — it only labels what's already there.
- **UI "Trigger import" button** — rejected. Two independent reasons: (1) the
  full FieldPulse prod import is blocked on an API key this repo doesn't
  have, so a trigger button would either no-op or need mocking to even
  demo; (2) the existing CLI (`run-import.ts:365-379`) requires typing
  `import` on stdin before any write, specifically to prevent an accidental
  prod write — a UI button would remove that safety gate. Out of scope.
- **Per-record error drill-down (which specific FP ids failed)** — rejected
  for this round. `run.error` is a single string, often a stack trace
  (`page.tsx:220-222`, skill gotcha), and `counts.errors` is just a number —
  there is no persisted list of failing record ids to drill into. Building
  one means a new table and a new write path in every importer; no operator
  complaint on record. Noted as a real future idea, not built now (YAGNI).
- **Historical trend chart (duration/error-rate over time)** — rejected.
  Nice-to-have polish with no evidence of demand; the recent-runs table
  already answers "did the last run work."
- **Pagination/filter on the recent-runs table** — considered for
  Gfieldpulse-import-4 (25-row cap). Left as a recorded P2, not built this
  round — daily nightly cadence means 25 rows covers roughly the last few
  days today, and this severity gate (METHOD.md) only promotes P0/P1 to
  requirements.

## 3. Current state

**Page / components** (verified — read in full):
- `src/app/admin/(dashboard)/fieldpulse-import/page.tsx` (239 lines) — a
  `PIPELINE_ORDER` constant hardcodes exactly 4 phase names,
  `['technicians', 'customers', 'jobs', 'invoices']` (`:22`); the phase-card
  grid maps only over that constant (`:201-230`); the `RecentRunsTable`
  below, by contrast, renders every row the API returns unfiltered by phase
  (`:171,235`). Refresh button is conditionally hidden whenever `isPolling`
  is true (`:189-196`).
- `src/components/admin/fp-import/import-status-model.ts` — `PIPELINE_PHASES`
  independently hardcodes the same 4 names (`:23`); `latestRunPerPhase` only
  ever looks up those 4 (`:25-39`); `progressPct`/`formatElapsed`/`runTone`
  are phase-agnostic pure helpers (`:41-78`).
- `src/hooks/use-fp-import-status.ts` — `nextPollDelay` checks
  `runs.some(r => r.status === 'running')` across **all** returned rows,
  regardless of phase (`:29-32`) — so a running `estimates` or `items` phase
  correctly keeps the client polling even though its card is never rendered.
  `fetchStatus` hits `/api/admin/integrations/fieldpulse/import-status`
  (`:45`).
- `src/app/api/admin/integrations/fieldpulse/import-status/route.ts` —
  session-gated (`:13-14`), rate-limited (`:16-21`), org-scoped select
  (`eq(fpImportRuns.organizationId, session.organizationId)`, `:26`), ordered
  `desc(startedAt)`, `limit(25)` (`:27-28`) — no phase filter, no pagination.

**Import pipeline** (the data source this page observes; verified):
- `src/lib/integrations/fieldpulse/import/run-import.ts` — the real pipeline
  is `PHASES` (`:75-169`): **technicians, customers, jobs, invoices,
  estimates, payments, assets, comments, locations, items, job-metrics** —
  11 phases, not 4. Each phase inserts a `status: "running"` row
  (`:397-406`), flushes `counts` to that row every 2s while executing
  (`:411-418`), and on completion/exception updates the same row to
  `completed`/`failed` with `finishedAt` (`:420-455`). There is no
  `process.on('SIGINT'|'SIGTERM', …)` handler anywhere in the file (grepped,
  0 matches) — a killed process (OOM, network drop, CI runner failure, or
  the 150-minute job timeout below) leaves that phase's row `status:
  "running"` forever; earlier phases in the same run already show their
  correct terminal status because each phase's row is independent.
- `.github/workflows/fp-nightly-sync.yml` — runs all 11 phases nightly at
  08:30 UTC (`:35,66`) with `timeout-minutes: 150` (`:41`) and
  `cancel-in-progress: false` (`:48`); a run that exceeds 150 minutes is
  killed by GitHub Actions with no app-level cleanup of the in-flight row.
  Comment block explains why Actions and not a Vercel cron: the customers
  sweep alone takes ~20 minutes, past Vercel's serverless ceiling (`:1-8`).
- Idempotency (verified, already correct — do not re-litigate):
  `customers.fieldpulseCustomerId`, `service_requests.fieldpulseJobId`, and
  `invoices.fieldpulseInvoiceId` each have a per-org **partial unique index**
  (`WHERE … IS NOT NULL`) — `src/lib/db/schema.ts:822-824` (customers),
  `:651-653` (requests), `:2792-2794` (invoices). Customer contact-dedupe
  goes through the HMAC blind-index `upsertCustomerByContact`
  (`src/lib/integrations/fieldpulse/import/customers.ts:313-368`, guarded so
  a re-run never clobbers a different fpId, `:322-358`). Invoice upserts use
  `db.batch` (not `db.transaction`, which throws under neon-http) for the
  update+line-items+audit triple (`src/lib/integrations/fieldpulse/invoice-sync.ts:415,490`).
  Money fidelity is correct: real `taxCents`/`subtotalCents` from FP,
  `subtotalCents = totalCents - taxCents` (not FP's raw pre-discount
  subtotal), `issuedAt` from `invoice.invoicedDate` (not the QB-bulk-import
  `createdAt`) (`invoice-sync.ts:348-357,424-429,481`). Per-record errors are
  caught and counted, never abort the phase walk
  (`customers.ts:409-421`, `invoices.ts:91-101`).

**Gotchas already documented**
(`.claude/skills/page-fieldpulse-import/SKILL.md:38-42`, verified): Refresh
hidden while polling, never show both; `run.error` may be a long stack trace
(`break-words text-xs` is load-bearing); `counts` is JSONB, cast at read
sites.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gfieldpulse-import-1: Phase-card grid only covers 4 of the 11 real pipeline phases | P1 | `PIPELINE_ORDER` (`page.tsx:22`) and `PIPELINE_PHASES` (`import-status-model.ts:23`) both hardcode `['technicians','customers','jobs','invoices']`; the actual nightly sweep runs `PHASES` from `run-import.ts:75-169` — 11 phases including `items` (17.5k pricebook rows, the phase most prone to the documented `cappedByMaxPages` truncation warning, `docs/FIELDPULSE-DATA.md:96-98`) and `job-metrics`. An operator watching the 4-card grid sees all green/"Completed" while `estimates`, `payments`, `assets`, `comments`, `locations`, `items`, or `job-metrics` could be `running`, `failed`, or racking up `errors` — invisible on the primary at-a-glance surface (only reachable by scrolling the unfiltered `RecentRunsTable`, `page.tsx:235`). |
| Gfieldpulse-import-2: No stale/orphaned-run detection — a killed import process leaves a permanent false "Running" | P1 | `run-import.ts` has no `SIGINT`/`SIGTERM` handler (0 matches on grep) and the GH Actions job has `timeout-minutes: 150` with no cleanup step (`fp-nightly-sync.yml:41`); a killed process leaves `fpImportRuns.status = 'running'` forever. `nextPollDelay` (`use-fp-import-status.ts:29-32`) then polls forever, and the Refresh button stays hidden the whole time (`page.tsx:189-196`, `isPolling` never turns false) — the operator has no way, from the UI, to distinguish "still actively running" from "died 6 hours ago" and cannot even manually refresh to check for other news. |
| Gfieldpulse-import-3: Approximate created/updated counts for the customers phase are presented as exact | P2 | `customers.ts:21-25` documents that path (b) (contact-dedupe match) always counts as `created`, even when the row pre-existed — "the count slightly over-reports created vs updated" (module doc, `:24-25`). The UI's `TalliesRow` (`page.tsx:74-87`) renders `Created:`/`Updated:` with no caveat, asterisk, or tooltip. |
| Gfieldpulse-import-4: Recent-runs table hard-capped at 25 rows, no pagination or phase filter | P2 | `import-status/route.ts:27-28` — `.limit(25)`, no `offset`/cursor param, no phase query param. With 11 phases per nightly run, 25 rows covers roughly the 2 most recent sweeps; older history is simply unreachable from this page. |
| Gfieldpulse-import-5: Recent-runs "Started" column has no relative-time hint | P2 | `page.tsx:154-156` renders `new Date(run.startedAt).toLocaleString()` only — locale/timezone-dependent, no "2h ago" style hint an operator can scan quickly. |

That's the full list. Idempotency, money fidelity, and per-record
partial-failure containment in the underlying importers are already solid
and evidenced above; this spec does not invent work there — it fixes what
this specific *page* fails to surface.

## 5. Requirements

Only Gfieldpulse-import-1 and -2 clear the P0/P1 bar.

- **Rfieldpulse-import-1**: The phase-card grid and `latestRunPerPhase` must
  cover all real pipeline phases, not a hardcoded subset of 4.
  **Acceptance criterion**: the list of phase names driving both the card
  grid (`page.tsx`) and `PIPELINE_PHASES` (`import-status-model.ts`) is a
  single shared source of truth kept in sync with `PHASES` in
  `run-import.ts` (e.g. a small shared array of phase name strings each side
  imports — not two independently hand-maintained literals, which is the
  root cause of this gap). A `vitest` unit test on `latestRunPerPhase` (no
  jsdom) asserts all 11 phase names — `technicians, customers, jobs,
  invoices, estimates, payments, assets, comments, locations, items,
  job-metrics` — are resolvable, and a run for any of the 7 currently-missing
  phases is picked up. Visual: screenshot
  `/admin/fieldpulse-import` and confirm 11 cards render (grid layout may
  wrap to more rows; no layout requirement beyond "does not overflow
  horizontally," per the responsive convention already in use).
- **Rfieldpulse-import-2**: A run whose `status === 'running'` and whose
  `startedAt` is older than a fixed staleness threshold (comfortably past
  the GH Actions 150-minute ceiling, e.g. 3 hours) must render a visibly
  distinct "Stale" state instead of (or alongside) "Running", and must not
  keep the Refresh button permanently hidden.
  **Acceptance criterion**: a new pure function (e.g. `isStaleRun(run,
  nowMs)`) — no I/O, no DB write, matching the page's observability-only
  invariant — returns true only for `running` rows past the threshold; a
  `vitest` unit test covers: fresh running → false, stale running → true,
  completed/failed (any age) → false. The status chip or card visibly
  differs for a stale run (e.g. a distinct label/tone, not the same
  indefinite "Running" pulse), and Refresh becomes available whenever every
  currently-"running" row is actually stale (so the operator is never stuck
  with zero way to force a re-check).

## 6. Non-goals

- Not adding a "trigger import" button — blocked on a FieldPulse API key
  this repo doesn't have, and would bypass the CLI's deliberate
  type-`import`-to-confirm write guard (Brainstorm, rejected).
- Not adding a "cancel run" mutation — page is observability-only by
  invariant; Rfieldpulse-import-2 is display-only, never writes to
  `fp_import_runs` (Brainstorm, rejected in favor of a pure derived badge).
- Not building per-record error drill-down — no persisted per-record error
  list exists yet; would need a new table and new write paths in every
  importer (Brainstorm, YAGNI for this round).
- Not building a historical trend chart or table pagination/filtering —
  Gfieldpulse-import-3/4/5 are recorded P2 and left in the backlog per
  METHOD.md's severity gate; not implementation work in this run.
- Not touching any importer logic (`customers.ts`, `invoices.ts`, `jobs.ts`,
  etc.) — their idempotency and money fidelity are already verified correct
  (Current state); this spec is page-surface-only.

## 7. Invariants

- **Observability-only, no mutations from this page**
  (`.claude/skills/page-fieldpulse-import/SKILL.md:34-35`) — both
  requirements are read/display changes; Rfieldpulse-import-2's staleness
  check must stay a pure client-computed derivation, never a write to
  `fp_import_runs`.
- **Pipeline order is fixed and phase cards render in that order**
  (skill:27-28) — Rfieldpulse-import-1 extends the order to all 11 phases,
  it does not reorder or make the order dynamic.
- **`ElapsedTime`'s 1s `setInterval` ticks live and cleans up on unmount**
  (skill:29-31) — untouched by either requirement.
- **Status chip colors: token classes only** (skill:32-33) — any new "Stale"
  visual state must use existing token classes (`bg-*-light`/`text-*` from
  `status-colors.ts` conventions), never a raw hex/palette value.
- **Tenancy**: `fp_import_runs` reads stay scoped to
  `session.organizationId` (`import-status/route.ts:26`) — neither
  requirement touches the query's `WHERE`, only client-side derivation.
- **neon-http has no transactions**: not touched by this spec (no new writes
  proposed), but noted so a future editor doesn't add one — the importers
  already correctly use `db.batch` (`invoice-sync.ts:415,490`).
- **Full FieldPulse prod import is blocked on a missing API key** — no
  requirement in this spec requires a live FP connection to verify; test
  fixtures/seeded `fp_import_runs` rows are sufficient.
- **`counts` is JSONB, cast as `FpRunCounts` at read sites** (skill:43-44) —
  unchanged.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/app/admin/(dashboard)/fieldpulse-import/page.tsx src/components/admin/fp-import/import-status-model.ts src/hooks/use-fp-import-status.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline
  (`docs/page-program/README.md`).
- Updated/new pure-function unit tests (no jsdom/RTL, per repo convention):
  `npx vitest run src/components/admin/fp-import/import-status-model.test.ts src/hooks/use-fp-import-status.test.ts`
  — extended with the 11-phase and stale-run cases from Rfieldpulse-import-1/2.
- Manual/visual: `npm run dev` (background) → mint an admin session
  (`npx tsx scripts/agent/mint-admin-session.mjs`) → seed `fp_import_runs`
  rows covering all 11 phases plus one artificially old `running` row (e.g.
  `startedAt` 5 hours in the past) → screenshot
  `node scripts/agent/screenshot-page.mjs /admin/fieldpulse-import` and
  confirm: 11 phase cards render, the stale row shows a distinct state, and
  Refresh is reachable. Look at the image before claiming success.
