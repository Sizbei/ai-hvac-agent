# FieldPulse Full Import — prod data foundation (backfill + steady sync)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, ONE PHASE AT A TIME. Steps use checkbox (`- [ ]`) syntax.

> **Review status:** adversarially reviewed 2026-07-09 (verdict: SOUND WITH CHANGES); all Critical/Important findings folded in — see Phase 0.5 (paging + job-status-int + filter verification gates), Phase 3 known-limitations, Phase 5 export note, Phase 6 delta/convergence semantics, Phase 7 reframe.

**Goal:** Populate the prod database with the org's real FieldPulse data — technicians, customers, jobs (with their schedules → the calendar), and invoices — via a re-runnable one-shot backfill, then keep it fresh with the existing webhook + cron machinery ("a steady system").

**Architecture:** One-shot backfill runs as a **local operator script** (`npm run fp:import` — like `db:migrate`/`db:seed`), not a serverless route: paging a full FP account through Vercel functions would hit time limits, while a local script has none and this is a one-time operation per org. The script executes phase functions in dependency order (technicians → customers → jobs → invoices), each **idempotent** (upserts keyed on the existing per-org unique `fieldpulse*Id` indexes) so the whole import is safely re-runnable. Steady state afterwards = the already-live webhooks (job status, invoice events) + existing crons, extended with a nightly technicians/customers/jobs delta sweep.

**Tech Stack:** existing `RestFieldpulseClient` (retry/backoff, token-bucket rate limiter, `fetchAllPages`), Drizzle over Neon HTTP, `upsertCustomerByContact` (HMAC blind-index dedupe), `upsertInvoiceRecord` (money-grade mirror), `syncTechniciansFromFieldpulse` (already built).

---

## Ground truth (verified 2026-07-09)

- **`fieldpulse_connections` is EMPTY in prod** — no API key connected. Phase 0 is a hard blocker.
- Prod contents today: 8 customers, 3 technicians, 12 service_requests, 4 native invoices, **0 FP invoices**, 0 follow-ups.
- FP-id columns + per-org unique indexes already exist: `customers.fieldpulseCustomerId`, `users.fieldpulseUserId`, `serviceRequests.fieldpulseJobId`, `invoices.fieldpulseInvoiceId`.
- Verified FP endpoints (docs/INTEGRATIONS.md, live-tested 2026-06): `/customers`, `/jobs`, `/jobs/{id}`, `/invoices`, `/invoices/{id}`, `/users`, `/estimates`, `/payments`, `/teams`. Known quirks: `{ error, response, total_count }` envelope; numeric ids (→ `idStr()`); money as dollar-strings (→ `dollarsToCents()`); `"YYYY-MM-DD HH:MM:SS"` dates; `/invoices?job_id=` ignored server-side; flat customer address fields.
- `fetchAllPages` caps at 20 pages × 100 — fine for delta syncs, must be parameterized for backfill.
- There is **no appointments table**: FP job schedules map onto `serviceRequests` schedule/arrival-window fields — that IS the calendar the dispatch board and slot-picker read.
- **Follow-ups: no known FP resource.** FP exposes job notes (one-way push today) but no `/follow_ups` endpoint was verified. See Open Questions.

## Global Constraints

- **Idempotent everywhere:** every upsert keys on the per-org `fieldpulse*Id` unique index (`onConflictDoUpdate`/`DoNothing` — the same CAS pattern as `upsertInvoiceRecord`). Re-running the import must be a no-op plus deltas.
- **Org-scoped everywhere**; PII (names/emails/phones/addresses) encrypted via the existing `encrypt()` path — never plaintext columns.
- **Never mutate FP** during import — the backfill is strictly read-from-FP, write-to-native. (Outbound push paths stay untouched.)
- **Dependency order is mandatory:** technicians → customers → jobs → invoices (jobs need `fieldpulseCustomerId` + `fieldpulseUserId` resolved; invoices link both).
- **Dry-run first:** `npm run fp:import -- --dry-run` prints per-entity counts (from `total_count`) and a sample mapping without writing. The real run requires `--org <id>` explicitly.
- Neon HTTP: no transactions; use `db.batch()` where multi-statement atomicity matters (mirror `upsertInvoiceRecord`).
- Rate limiting: route ALL paging through the existing client token bucket; backfill sets a conservative bucket (e.g. 2 req/s) — an account with thousands of records still finishes in minutes locally.
- Conventional commits, no Co-Authored-By; TDD on every mapping function (the FP→native mappers are pure — test them with the real-shape fixtures already in `client-real-shapes.test.ts`).

---

## Phase 0 — Connect FieldPulse (USER ACTION — blocker)

No code. The org's FieldPulse API key must be connected first:
1. Admin → Integrations → FieldPulse → paste API key (`POST /api/admin/integrations/fieldpulse/connect` validates via `getAccountInfo()` and stores it encrypted), **or** set `FIELDPULSE_API_KEY` env for the script-only path (`config.ts` already falls back to it).
2. Verify: `npm run smoke:fieldpulse` (key-gated live smoke: account info + users + invoice shapes).

**Exit criteria:** smoke test green; `fieldpulse_connections` row exists (or env key confirmed).

## Phase 0.5 — Live shape & paging verification (gate for everything below)

Extend the smoke harness to CAPTURE, against the real account, before any import code is written:
1. **Paging actually advances** (review finding I1): fetch `/customers` page 1 and page 2, assert they differ and that accumulating pages approaches `total_count`. `fetchAllPages`'s repeated-batch guard silently stops after page 1 if FP ignores the `page` param — for a backfill that's a silent partial import that reports success. If paging doesn't advance, STOP and find the real paging params before proceeding.
2. **A real `/jobs` payload** (review finding C1): the FP job's `status` is an INTEGER with unconfirmed vocabulary, and the narrowed `FieldpulseJob` type carries no jobType/address fields — capture full raw job objects (several statuses) to build the Phase-4 mapper from evidence, not assumption. The webhook's existing status mapper switches on STRING labels and would return null for every integer — it cannot be reused as-is.
3. **Whether any server-side `updated_at`/date filter exists** on list endpoints (review finding I3) — the `--since` delta design depends on it; FP already ignores `job_id` on `/invoices`, so assume nothing.

**Exit criteria:** captured fixtures checked into the test fixtures dir; paging confirmed; status-int vocabulary table written into `docs/INTEGRATIONS.md`.

### Phase 0.5 RESULTS (live-probed 2026-07-09, account 182499)

- **Paging:** `page` param WORKS (page 2 ≠ page 1). **`page_size` is IGNORED** — `/customers` returns a fixed 50/page, `/jobs` 20/page. `total_count` present on `/customers` (2597) and `/jobs` (54); **null on `/invoices`** → invoice backfill sizes by walking pages until empty, not by total_count; the dry-run completeness assert applies only where total_count exists.
- **Volume:** 2,597 customers (52 pages), 54 jobs (3 pages), invoices TBD (≥20). Nightly full re-page is cheap at this scale.
- **`updated_at_from` filter: IGNORED** (2099-dated filter returned identical results) → per review I3, deltas = full re-page + client-side `updated_at` filtering. Acceptable at this volume.
- **Job shape (fixture: fp-jobs-page1.json):** `job_type` EXISTS (free text: "HVAC DOWN", "Walk in beer cooler"), `start_time`/`end_time` (schedule → our calendar), `customer_arrival_window_start_time/_end_time`, `assignments` (tech assignment), `customer_id`, `completed_at`, `invoice_status`, `deleted_at` (**must skip soft-deleted rows**), plus `in_progress_status_log`/`on_the_way_status_log`. Status ints observed: `{1: 12, 2: 4, 3: 2, 4: 2}` — vocabulary to pin in Phase 4 by correlating with `completed_at`/status logs/FP UI (e.g. `completed_at` non-null corroborates a terminal status independent of the int).

## Phase 1 — Import runs ledger + script skeleton (1 migration)

- **Migration:** `fp_import_runs` table — `id`, `organizationId`, `phase` (`technicians|customers|jobs|invoices`), `status` (`running|completed|failed`), `counts` jsonb (`{fetched, created, updated, skipped, errors}`), `error` text, `startedAt`, `finishedAt`. Observability + resumability cursor (`counts.lastPage`).
- **Script:** `src/lib/integrations/fieldpulse/import/run-import.ts` + `npm run fp:import` (tsx, loads `.env.local` like `db:migrate`). Flags: `--org <uuid>` (required), `--dry-run`, `--phase <name>` (run one phase), `--since <date>` (delta mode — semantics depend on the Phase-0.5 filter verification; without a server-side filter it means full re-page + client-side date filter).
  - **Prod-target confirmation** (review M3): before the first write, the script prints the resolved DB host + org id + org name + a per-entity dry-run count summary and requires a typed `import` confirmation — there is no server-side guardrail on a local script pointed at prod.
  - **Dry-run completeness assert** (review I1): dry-run reports `fetched` vs `total_count` per entity and FAILS LOUDLY on a shortfall — never report success on a partial page walk.
- **Client additions** (follow the existing interface+impl pattern — `fetchAllPages` is private and already takes a `maxPages` param, default 20): public `listCustomers`, `listJobs`, `listInvoices` methods on the client that page unfiltered and pass a backfill-sized `maxPages` (e.g. 500). Each new method gets a real-shape unit test using the Phase-0.5 captured fixtures.

## Phase 2 — Technicians (mostly wiring — the sync already exists)

- `syncTechniciansFromFieldpulse(orgId)` is built (upserts on `(org, email)`, sets `fieldpulseUserId`, soft-deactivates removed). The import script calls it as phase `technicians`.
- Record counts into `fp_import_runs`.
- **Steady state:** add it to the existing daily FP cron (it currently only runs availability + invoices) so roster changes flow without manual triggers.

## Phase 3 — Customers inbound pull (new)

- `importCustomersFromFieldpulse(orgId, opts)` in `import/customers.ts`:
  1. Page `listCustomers` (100/page, token-bucketed).
  2. Pure mapper `mapFpCustomer(fp)` → `{ name, email, phone, address (from flat address_1/2/city/state/zip_code), companyName, fpId: idStr(fp.id) }` — TDD with real-shape fixtures.
  3. For each: if a native row already has this `fieldpulseCustomerId` → UPDATE contact fields (encrypted) if changed; else `upsertCustomerByContact(orgId, mapped)` (HMAC email/phone dedupe — **this is what links FP records to customers who already booked through the bot**) then set `fieldpulseCustomerId` on the returned id, guarded against the per-org unique index (if another row already owns that fpId, count as `skipped` + log, don't clobber).
  4. Customers with neither email nor phone: still import (name/address only), keyed purely on `fieldpulseCustomerId`.
- **Known limitations (stated decisions, per review):**
  - **Contactless-FP-customer duplicates (review I2):** an FP customer imported with no email/phone has null contact hashes, so a LATER bot booking by the same human (who now provides a phone) creates a separate native row — a duplicate the dedupe can't see. Accepted for the foundation pass; mitigation = a later reconciliation pass (name+address match → suggest merge) and the existing admin customer view for manual merges. Documented, not silent.
  - **Un-archive on match:** `upsertCustomerByContact` clears `archivedAt` when an import matches an archived native customer — desired (they're an active FP customer), and now an explicit decision.
- **Steady state:** nightly delta folded into the cron in Phase 6 (semantics per the Phase-0.5 filter verification).

## Phase 4 — Jobs → service_requests + the calendar (new)

- **GATED on Phase 0.5's captured job fixtures** — the FP job `status` is an integer with unconfirmed meanings and the narrowed `FieldpulseJob` type has no jobType/address fields; every mapping below is built from the captured shapes, not assumption.
- `importJobsFromFieldpulse(orgId, opts)` in `import/jobs.ts`:
  1. Page `listJobs`.
  2. Pure mapper `mapFpJob(fp)` — TDD against the captured fixtures. Maps: FP **integer** status → `serviceRequests.status` via a NEW `mapFpJobIntStatus(int)` built from the verified vocabulary (review C1 — the webhook's string-label mapper returns null for integers and must NOT be reused); statuses outside the verified vocabulary import with a safe default (`pending`) + a counted warning, never a guess. Summary/description → `issueDescription`; job type → `jobType` **only if the captured shape actually carries a type field** (the current narrowed type does not — otherwise leave the field for the AI-triage default); FP schedule start/end → **`arrivalWindowStart/End` + schedule fields — this is the "calendar" import**: the dispatch board and slot-picker read these.
  3. Resolve links: customer via `fieldpulseCustomerId` (Phase 3 guarantees it; if missing, create via the Phase-3 path inline), technician via `fieldpulseUserId` → `assignedTo`.
  4. Upsert keyed on `(org, fieldpulseJobId)`: insert new; update status/schedule/assignment on existing. **Never overwrite a native request that has no `fieldpulseJobId`** — FP-imported jobs are a disjoint keyed set.
  5. Completed/cancelled historical jobs import with their terminal status (they become service history, not queue noise) — the request queue's default filters already hide terminal states.
- **Steady state:** job status changes already flow via webhook; the nightly delta sweep catches new/edited jobs the webhook missed.

## Phase 5 — Invoices full-history backfill (extends the live mirror)

- `importInvoicesFromFieldpulse(orgId, opts)` in `import/invoices.ts`: page the **unfiltered** `listInvoices` and feed each already-fetched row into `upsertInvoiceRecord` — **which requires EXPORTING it from `invoice-sync.ts`** (review C2: it is module-private today; the exported `pullInvoiceFromFieldpulse` re-fetches by id and would add N wasteful GETs). Small explicit code change, not plain reuse. The upsert is already idempotent, money-grade, line-item-replacing, state-derived-from-amounts, and **degrades to null customer/job links** when they're absent — so this phase tolerates gaps, but the ordering still matters for correct linkage.
- This closes the known gap: the daily invoice cron only sweeps invoices for jobs we already track; the backfill catches the org's full history. Synced invoices stay read-only in native money flows (existing guard) — and are **excluded from collections dunning** (existing `syncedSource` gates).
- **Steady state:** unchanged — webhooks + the existing daily sweep; consider pointing the sweep's per-job pull at the delta path once the backfill exists.

## Phase 6 — Steady-state consolidation

- Extend the daily FP cron chain to: technicians → customers delta → jobs delta → (existing) availability + invoices. Per-org `after()` fan-out, `fp_import_runs` rows for each sweep (same observability as the backfill).
- **Delta semantics depend on Phase 0.5** (review I3): if FP honors a server-side `updated_at` filter, `--since` is a cheap delta; if not (likely — FP ignores even `job_id` on `/invoices`), the nightly sweep is a **full re-page with client-side date filtering** — still idempotent and safe, just costlier; size it (records × 100/page × token bucket) and accept, or reduce cadence.
- **Webhook/sweep convergence (review I4):** both the live webhook and the nightly sweep write *current FP state* (same principle as the invoice mirror), so they converge rather than conflict; the sweep must always write from a fresh FP read, never a cached one, so a lagging list can't stomp a newer webhook write with stale data for long — the next sweep self-corrects. State this invariant in the sweep's module comment.
- Add an **Integrations UI status card**: last import/sweep per entity + counts + last error (reads `fp_import_runs`), so drift is visible without the DB.

## Phase 7 — Deferred entities (explicit decisions, not oversights)

- **Estimates + payments (VERIFIED FP endpoints, descoped for the foundation pass — review M1):** `/estimates` and `/payments` work but have no client methods today. Skipping payments means imported invoices carry FP's `amount_paid` totals without per-payment event history; skipping estimates omits the pre-sale funnel. Both are clean later increments on the same import skeleton (client method → mapper → upsert keyed on a new per-org fp-id column, 1 small migration each). Descoped now to keep the foundation pass focused on the four entities the user named.
- **Follow-ups (NO verified FP resource):** options —
  - **(a)** Derive: create native `follow_ups` from imported job data (maintenance-type jobs → due follow-up; warranty dates) — pure-native, no FP dependency.
  - **(b)** Probe the FP API for a tasks/reminders resource (not in the verified list; may not exist).
  - **(c)** Descope: follow-ups remain native-only (staff-created / existing warranty triggers).
  Recommendation: **(c) now, (a) as a later increment** — don't block the data foundation on an unverified API surface.

---

## Execution & safety notes

- Each phase = one SDD task (implementer + review), executed in order; the backfill script is testable end-to-end against the dry-run before any prod write.
- **First real run happens with the user present** (it writes bulk data to prod): dry-run → review counts → run `--phase technicians` → verify in admin → proceed phase-by-phase.
- Rollback story: every imported row carries its `fieldpulse*Id`, so a bad import is identifiable (`WHERE fieldpulse_job_id IS NOT NULL AND created_at > <run start>`) and reversible per-entity without touching native data.
- Collections/dunning safety: imported invoices are synced ⇒ read-only, never dunned, excluded from reminder flows (existing guards — verified in Phases 3–6 of the collections work).

## User decisions (2026-07-09)
1. **API key** — PROVIDED; stored in `.env.local` (gitignored) + encrypted `fieldpulse_connections` row. Phase 0 smoke PASSED (account 182499, 11 users).
2. **History cutoff** — **ALL history.**
3. **Follow-ups** — **native-only now** (option c), with a committed later phase:

## Phase 8 — Derive follow-ups from imported job data (committed later increment)

Once Phases 2–5 are live: a pure-native derivation pass that creates `follow_ups`
rows from imported FP job history — e.g. completed maintenance-type jobs → a due
follow-up at the next service interval; warranty-dated equipment from job line
items → warranty-expiry follow-ups (reusing the existing warranty-trigger
machinery). No FP API dependency; idempotent (keyed on customer + reason + due
date); runs as part of the nightly sweep. Design in its own plan when Phases 2–5
have shipped and real imported data shapes are known.
