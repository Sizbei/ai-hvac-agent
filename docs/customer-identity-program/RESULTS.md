# Dev backfill results — customer identity program

Run: 2026-08-12/13, dev Neon branch only. Counts and mechanisms only — no
dollar figures (public repo). All phases via the shipped importer; zero manual
SQL surgery.

## Runbook execution

| Step | Result |
|---|---|
| Migrations 0045+0046 on dev | applied; `pg_indexes` shows the 2 native uniques + 2 lookup indexes, legacy uniques gone |
| Intake smoke (live arbiter) | OK — upsert twice → same row, no 42P10, throwaway removed |
| `--phase customers --split-shared-contacts` | `fetched=2632 created=373 updated=2259 errors=0` in 1,116s; probe confirmed legacy uniques absent before the walk |
| `--phase jobs` | `fetched=191 created=154 updated=37 errors=0` |
| `--phase invoices` | `fetched=3004 created=16 updated=2988 errors=0` in 2,162s |
| `--phase estimates` | `fetched=101 created=65 updated=36 errors=0` |
| Reconcile (whole corpus) | 3,004/3,004 compared — see below |

## Before → after

| Metric | before | after |
|---|---|---|
| FP-invoice orphans (`customer_id IS NULL`) | **501** (94 unpaid) | **3** (0 unpaid) |
| FP-estimate orphans | 2 of 36 | 1 of 101 |
| customers-phase per-record errors | 9, deterministic, nightly | **0** |
| FP-linked customer rows | 2,280 | 2,653 |
| native rows (dedupe-protected population) | 9 | 9 (bound held; no claims fired) |
| duplicate-hash groups | 0 (impossible) | 125 email / 60 phone — the split's signature |
| distinct customers owning FP invoices | — | 962 |

Census identity holds as an inequality: 2,653 = 358 expected creations
(2,632 upstream − 2,274 previously-linked non-placeholder rows) + 15 rows whose
FP customers were hard-deleted upstream after earlier imports + 6 placeholders
already counted — exactly the census term review round 3 forced into SPEC §4.1.

## Reconciliation

3,004 of 3,007 mirrored invoices compared against live FieldPulse. 2 mismatches
appeared and were **proven transient**: both invoices carry upstream
`updated_at` stamps inside the sync walk's own window (live-business edits
mid-walk). Re-pulling each through the shipped `pullInvoiceFromFieldpulse`
converged both to the cent. The 3 uncompared rows are upstream-deleted
invoices (the known frozen class, includes fp `20776752`).

The 3 remaining invoice orphans carry **zero unpaid balance** — the
collections-actionability gap this program existed to close is closed.

## Gates at completion

`npx tsc --noEmit` 0 · eslint 0 on all changed files · vitest
**325 files / 4,405 passed / 1 skipped** (baseline 322/4,279/1; +126 tests)
· `verify-skills` 398 cited / 0 missing.

## Not done here (user-gated, by design)

Prod deploy (0045+0046 apply in the build; accepted-risk single deploy or
strict two-deploy — SPEC §7-prod); the flagged prod backfill; flipping
`fp-nightly-sync.yml` to `--split-shared-contacts` after that backfill; the
SPEC §4.5 prod state review (recorded STOPs / portal tokens / do-not-service
do not follow invoices across a split — dev had zero of each, so only prod can
exercise it). Follow-up queued: extract the split machinery from
`customers.ts` (1,116 lines) after the backfill has re-pinned the legacy path.
