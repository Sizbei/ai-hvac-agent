# SPEC — Re-pulling FieldPulse and Housecall Pro data

Request: "go ahead and repull from the api for work pro and fieldpulse"
("work pro" = Housecall Pro).

## 1. Purpose

Bring the DEV Neon mirror's FieldPulse-sourced tables (customers, jobs,
invoices, estimates, payments, assets, comments, locations, pricebook items)
back in sync with the live FieldPulse account — currently **~390 customers
behind** (2,241 local vs 2,631 upstream, `verified` live probe below) — and
determine what, if anything, can be done for Housecall Pro. Money integrity
(no double-counted invoices/payments) is the binding constraint; this spec
exists to prove a re-pull is safe before anyone runs one.

## 2. Brainstorm (considered and rejected)

- **Trigger the existing `fp-nightly-sync` GitHub Action manually
  (`workflow_dispatch`).** Rejected as the mechanism: the action has run
  successfully every night through 2026-08-10 (`verified`, `gh run list`),
  yet DEV's `fp_import_runs` ledger has zero rows after 2026-07-09 and DEV
  is still 390 customers behind. The action's `DATABASE_URL` secret almost
  certainly targets a database DEV doesn't share (`inferred`, §3.6) —
  dispatching it again wouldn't touch DEV. Fixing that wiring is a separate
  infra decision, out of scope here.
- **Run `npm run fp:import -- --org <uuid>` directly, right now.** The
  correct mechanism (§5) but forbidden by this task's constraints ("do not
  run the importer"). Documented for a later operator run, not executed.
- **Add a `--since` incremental filter to cut pull volume.** Rejected —
  already tried and reverted upstream. The importer's own header says FP
  ignores server-side date filters (Phase 0.5 finding), and `client.ts` has
  no date-filter query param anywhere. Every re-pull is necessarily a full
  re-page.
- **Point DEV's `.env.local` at production to get a "true" re-pull without
  waiting on infra.** Rejected outright — hard invariant, never point
  `.env.local` at `ep-withered-hill`.
- **Build an HCP backfill importer now, ahead of the key.** Rejected — no
  code closes the gap without a live key to test against (§6); building
  blind risks a dead-on-arrival pipeline. Defer until a key exists.
- **Treat the two `fp_import_runs` rows stuck at `status: 'running'` for 18
  days (§3.5) as safe to ignore.** Rejected — direct evidence of the exact
  failure mode FACTS.md flagged; the fix (a hand UPDATE on 2026-07-27) is
  not a repeatable procedure. Recorded as a P1 gap.

## 3. Current state (evidence-grounded)

### 3.1 Pipeline order and phase contracts (`verified`)

`src/lib/integrations/fieldpulse/import/run-import.ts:75-169` defines 11
phases run strictly in this order: `technicians → customers → jobs →
invoices → estimates → payments → assets → comments → locations → items →
job-metrics`. Ordering encodes real dependencies — `jobs` self-heals
missing customers, `invoices`/`payments` link to `jobs`/`customers` by FP
id, `payments` resolves against already-imported `invoices`
(`payments.ts:83-88`). `--phase` lets an operator run a subset but always
preserves canonical order (`run-import.ts:298-299`).

### 3.2 Idempotency — proven per phase, not assumed

Every FP-linked table carries a **partial unique index** on
`(organization_id, fieldpulse_*_id) WHERE fieldpulse_*_id IS NOT NULL`
(`src/lib/db/schema.ts:342-344, 651-653, 822-824, 890-892, 920-921,
2281-2282, 2690-2692, 2792-2794, 2863-2865`) — one per entity: users,
service_requests, customers, equipment, notes, pricebook_items, estimates,
invoices, payments. This is the structural backstop for idempotency.

Application-level dedupe, phase by phase:

| Phase | Dedupe mechanism | Evidence |
|---|---|---|
| technicians | `onConflictDoUpdate` on (org, email) | `technician-sync.ts:104` |
| customers | fpId lookup → UPDATE; else `upsertCustomerByContact` (HMAC blind-index) → link fpId guarded against overwrite; else `onConflictDoNothing` on the partial unique index | `import/customers.ts:262-408` |
| jobs | pre-selected `Set` of existing `fieldpulseJobId`s classifies new vs. existing before insert; update path never touches `on_hold` status | `import/jobs.ts:292-302, 474-541` |
| invoices | pre-selected `Set` of existing ids; `upsertInvoiceRecord` does explicit SELECT-then-branch (UPDATE existing / `onConflictDoNothing` insert, with a race fallback SELECT) | `import/invoices.ts:52-62`, `invoice-sync.ts:396-522` |
| estimates | pre-selected `Set`; `onConflictDoUpdate` | `import/estimates.ts:74-84, 161` |
| payments | pre-selected `Set`; `onConflictDoUpdate` targeted on the partial unique index | `import/payments.ts:71-81, 147-155` |
| assets | pre-selected `Set`; `onConflictDoUpdate` | `import/assets.ts:67-77, 131` |
| comments | `onConflictDoNothing` | `import/comments.ts:145` |
| locations | fills NULL addresses only, "never overwrites" (comment + logic) | `import/locations.ts:153` |
| items (pricebook) | pre-selected `Set`; `onConflictDoUpdate` | `import/items.ts:79-90, 137` |
| job-metrics | "pure overwrite... on every run" by design (no create/duplicate path — it's an UPDATE of an existing row's jsonb column) | `import/job-metrics.ts:9-13` |

**No phase inserts a row without either a DB-level partial unique
constraint or an app-level pre-selected existing-id check gating the
insert.** The `jobs` phase's insert (`import/jobs.ts:494`) isn't wrapped in
`onConflictDoNothing`, relying on the app-level `isNew` check plus the
unique index as backstop; under sequential single-process execution (the
only way this importer is ever run — no evidence of concurrent invocation
anywhere in the codebase) this cannot double-insert. A theoretical
concurrent-run race would throw on the unique-index conflict, caught
per-record (`errors++`, continue) — not a silent duplicate.

**Money-specific proof:** `invoices` and `payments` — the only two tables
that feed dollar amounts — both use `onConflictDoUpdate`/explicit
SELECT-then-branch keyed on the FP id, and `payments` is additionally
excluded from every aggregate (`collectedThisMonthCents`, sales report) via
`fieldpulsePaymentId IS NULL` guards (`docs/FIELDPULSE-DATA.md:44`) — a
duplicate payment row couldn't double-count revenue in reports even
hypothetically. No such duplicate is possible per the upsert proof above.

### 3.3 What a re-pull actually changes (`verified` from code)

- **Money tables (invoices, payments):** current-FP-state-wins by design.
  Every re-run REPLACES an existing invoice's money fields, state, and line
  items (delete + re-insert, `invoice-sync.ts:414-448`, in one
  `db.batch()`), and REPLACES a payment's amount/status
  (`payments.ts:150-154`). Intentional — synced invoices/payments are
  already documented read-only in every money flow
  (`docs/FIELDPULSE-DATA.md:25-27`), so there's no "locally-modified row"
  to protect: FP is the sole authority for these fields.
- **Customers:** every re-run overwrites name/email/phone/address/custom
  fields from FP (`updateCustomerFields`, `import/customers.ts:519-548`).
  Native customers are NOT read-only (`docs/FIELDPULSE-DATA.md:22`), so a
  locally-corrected phone/address on a linked customer **will be silently
  reverted**. Not new — the standing contract — but worth naming.
- **Jobs (service_requests):** every re-run overwrites `assignedTo`,
  `description`, schedule window, and `status` from FP — **except** a
  locally-set `on_hold` status, explicitly preserved
  (`import/jobs.ts:524-531`, "must not revert it"). A dispatcher's manual
  reassignment on an FP-synced job is not protected the same way and will
  be overwritten on the next pull.
- **Net effect of a fresh pull today:** backfills the ~390 missing
  customers and anything created upstream since 2026-07-09 (last recorded
  run), and refreshes already-imported rows to current FP state. No
  existing row is deleted; nothing is duplicated.

### 3.4 Money fidelity (`verified`)

- Tax/subtotal: `taxCents = invoice.taxCents ?? 0`; `subtotalCents =
  totalCents - taxCents` (NOT FP's raw pre-discount `subtotal`, which was
  proven not to reconcile) — `invoice-sync.ts:348-357`.
- `issuedAt`: `parseFpDate(invoice.invoicedDate ?? invoice.createdAt)`,
  written on both INSERT and UPDATE so re-imports backfill older rows —
  `invoice-sync.ts:424-429, 481`. Fix for the historical "issuedAt = import
  day" bug (code comment cites fp#20824708: invoiced 2025-10-30, created
  2026-07-07 — would've broken under the old logic).
- Paid-invoice guard: if FP reports `state: paid` with `amount_paid = 0`,
  the importer corrects `amountPaidCents` to `totalCents` so a paid invoice
  never displays as outstanding — `invoice-sync.ts:361-365`.

### 3.5 Partial failure and the stuck-run problem (`verified`, live DB read)

neon-http has no transactions; the codebase already accounts for this —
every multi-write phase step uses `db.batch()` (e.g. `invoice-sync.ts:415`,
update+delete+insert+audit in one call) rather than sequential awaits, and
phases are independent units (a phase failure doesn't roll back a prior
phase — nor should it, since each phase's writes are already individually
idempotent).

**Live evidence of the exact "stuck running" failure mode**, read from
DEV's `fp_import_runs` (read-only `sql.query`, temp script deleted after
use):

```
{"phase":"customers","status":"failed","started_at":"2026-07-09T12:11:18Z","finished_at":"2026-07-27T14:27:40Z"}
{"phase":"invoices","status":"failed","started_at":"2026-07-09T05:56:56Z","finished_at":"2026-07-27T14:27:40Z"}
```

Both rows share an identical `finished_at`, 18 days after `started_at` —
not a real 18-day run. `run-import.ts` has no SIGINT/SIGTERM handler
(`.claude/skills/page-fieldpulse-import/SKILL.md:39`), so a killed process
left these rows `status: 'running'` forever; they were only closed out by a
manual UPDATE on 2026-07-27, not by any code path in the repo. **There is
no automated reaper** — `isStaleRun` in `import-status-model.ts` is
display-only (changes what the admin page renders, never writes to the
DB). An operator hitting this today must hand-write the UPDATE.

**Recovery for a genuinely failed/interrupted phase:** since every phase is
independently idempotent (§3.2), just re-run it — no partial-state cleanup
needed. The gap is purely the stuck-row problem, not data corruption.

### 3.6 DEV is not touched by the existing automation (`inferred`, high confidence)

`gh run list --workflow=fp-nightly-sync.yml` shows the action completing
**successfully every night through 2026-08-10** (`verified`). Yet DEV's
`fp_import_runs` has no row newer than 2026-07-09, and DEV is still ~390
customers behind live FieldPulse (`verified`: `total_count: 2631` vs local
`customers: 2241`). The repo has exactly one `DATABASE_URL` GitHub secret
(`gh secret list`, set 2026-07-09T06:30:32Z — the same day as the
documented prod/dev branch split). The org id is identical in both
branches (`00000000-0000-0000-0000-000000000001`, confirmed live in DEV),
so it can't distinguish which database the action targets. The only
explanation fitting all the evidence: the nightly action's `DATABASE_URL`
targets production (or DEV is a frozen Neon branch fork predating it —
either way, DEV doesn't receive it). **Cannot verify the secret's value
(no credential access) — inferred, not proven — but the practical
conclusion is unambiguous: DEV needs its own manual re-pull.**

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| DEV mirror gets no automated sync; only a manual `fp:import` run closes the gap | P1 | §3.6 — 390 customers behind, zero `fp_import_runs` rows since 2026-07-09 despite the nightly action running green |
| Stuck `status: 'running'` rows have no automated reaper — recovery is a hand-written SQL UPDATE | P1 | §3.5 — two live rows sat `running` for 18 days; `isStaleRun` is display-only |
| Housecall Pro cannot be pulled — no credential exists in this environment | P0 (blocking, not a code defect) | FACTS.md: `HOUSECALL_API_KEY` unset, `housecall_pro_connections` has 0 rows |
| Housecall Pro has no full-import/backfill pipeline (only webhook-reactive sync modules) | P1 | `find src/lib/integrations/housecall-pro` — no `import/` directory, unlike FieldPulse |
| Re-pulling a linked customer's contact fields silently overwrites local corrections | P2 | §3.3 — `updateCustomerFields` always writes FP's name/email/phone/address |
| Dispatcher's manual technician reassignment on an FP-synced job is reverted by the next re-pull (only `on_hold` is protected) | P2 | `import/jobs.ts:524-531` |
| `jobs` phase insert relies on an app-level pre-check, not `onConflictDoNothing` (DB unique index is the only backstop) | P2 | `import/jobs.ts:494` vs. every other phase's explicit conflict clause |

Only P0/P1 become requirements below. The P2s are documented so nobody
re-discovers them, not because they block a re-pull.

## 5. Requirements

**Rpull-1 — The re-pull runs as a local/manual `fp:import` invocation
against DEV, not via the existing GitHub Action.**
Acceptance: the operator runs `npm run fp:import -- --org
00000000-0000-0000-0000-000000000001` from a shell with `.env.local`
loaded (confirmed DEV host `ep-patient-surf-...`), types `import` at the
interactive confirmation, and lets all 11 phases complete. `--dry-run`
first is recommended (fetches page 1 only, zero writes) to sanity-check
connectivity before the real run. This spec does not perform this run —
constraints for this task forbid it.

**Rpull-2 — Before any operator runs a re-pull, the DEV vs. prod target of
the nightly `fp-nightly-sync` GitHub Action's `DATABASE_URL` secret must be
confirmed (not just inferred).**
Acceptance: someone with repo-secret access confirms which Neon branch the
action's `DATABASE_URL` points at. If DEV and still not landing rows, that
is a different (code) bug needing its own investigation; if prod (or DEV
was branch-forked once and never resynced), that confirms §3.6. Read/confirm
only, not a code change.

**Rpull-3 — A reaper closes stuck `running` `fp_import_runs` rows.**
Acceptance: a script (or a check added to `run-import.ts`'s startup) marks
any `fp_import_runs` row `status: 'running'` older than the existing
`STALE_RUN_THRESHOLD_MS` (3h, already defined for the display layer) as
`status: 'failed', error: 'stale run — no process update in >3h'`, either
before a new run of the same phase begins or via a standalone `npm run
fp:reap-stale` command. Acceptance test: seed a row with `status:
'running'` and `started_at` 4h in the past; after the reaper runs, it reads
`status: 'failed'` and a fresh run for that phase isn't blocked by it.

## 6. HCP readiness — what's needed the day a key arrives

- **Env var:** `HOUSECALL_API_KEY` (single-tenant fallback, `config.ts:30`)
  — or, for the multi-tenant path, an admin submits the key through the
  already-built `POST /api/admin/integrations/housecall/connect` route,
  which live-probes `getAccountInfo()` before encrypting and persisting to
  `housecall_pro_connections`. **This route is fully built** — super_admin-
  gated, rate-limited, audited — nothing to build there. Its own error
  message notes HCP requires the account be on the MAX plan for API access.
- **What the first pull would do today:** nothing, because there is no
  full-import pipeline. `src/lib/integrations/housecall-pro/` has
  customer/job/invoice/note/webhook/technician sync + bulk-operations — all
  reactive (webhook-driven or single-record pull-by-id), with **no
  `import/` directory and no `run-import.ts` analog.** Connecting a key
  starts webhook events flowing forward; it backfills nothing historical.
- **What's missing:** an HCP equivalent of `fieldpulse/import/run-import.ts`
  — phased full-history backfill with the same idempotency guarantees. Do
  not build this speculatively — nothing to test it against without a live
  key, and a blind port risks silently wrong field mappings.

## 7. Non-goals

- Not building or running an HCP backfill importer (§6) — blocked on a
  credential that doesn't exist.
- Not fixing the `fp-nightly-sync` DATABASE_URL target (Rpull-2) — a
  secrets/infra change outside this spec's read-only mandate.
- Not adding an incremental (`--since`) pull mode — already tried and
  rejected upstream (§2); every pull is a full re-page.
- Not changing the customer/job "current-FP-state-wins" overwrite behavior
  (§3.3, P2 gaps) — a deliberate, documented product decision, not a bug
  this spec is scoped to fix.
- Not executing `npm run fp:import` — forbidden by this task's constraints;
  Rpull-1 documents the command for a later operator run.

## 8. Invariants

- `.env.local` targets the DEV Neon branch only; never `ep-withered-hill`
  (prod).
- Every FP-linked table's write path goes through its partial unique index
  on `(organization_id, fieldpulse_*_id)` — never remove or bypass it.
- `payments` imported from FieldPulse stay excluded from
  `collectedThisMonthCents` and the sales report via `fieldpulsePaymentId
  IS NULL` guards — never blend synced money into native aggregates.
- Synced invoices/payments/estimates remain read-only in every money
  mutation flow (reminder, pay-link, void, refund, mark-sold).
- neon-http has no `db.transaction()` — any new multi-write logic
  (including a future reaper) uses `db.batch()`.
- No destructive action against the live FieldPulse API (GET only) or the
  DB (read-only) in service of writing this spec — upheld throughout.

## 9. Verification

This spec is documentation-only; there is no code to gate. To validate its
claims independently:

- Re-run the live probe: `GET {FIELDPULSE_BASE_URL}/customers?limit=1` with
  the `x-api-key` header from `.env.local` → expect HTTP 200, `total_count`
  at or above 2,631.
- Re-run the DEV read-only count check (customers, invoices,
  fp_import_runs) to confirm the gap and last-run timestamp haven't
  silently changed.
- `node scripts/agent/verify-skills.mjs` → 0 missing.
- Before Rpull-1 is ever executed for real: `npx tsc --noEmit` and
  `npx vitest run` baseline must already be green (this spec makes no code
  changes, so both should be unaffected).
