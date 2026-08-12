# Implementation plan — customer identity program

Authority: `SPEC.md` (this directory), hardened through 3 adversarial rounds.
This plan sequences it; it does not restate it. When this plan and the spec
disagree, the spec wins — stop and surface the disagreement, do not improvise.

**Vitest baseline, captured live on this branch before any work:
322 files · 4,279 passed · 1 skipped.** Every task gate holds this or better.

## Invariants binding every task

- `.env.local` = DEV Neon branch (`ep-patient-surf`). NEVER prod
  (`ep-withered-hill`). The backfill in Wave 4 targets dev only.
- neon-http: `db.transaction()` throws — `db.batch()` only.
- No jsdom/RTL. Pure-helper vitest; DB functions tested via the chainable
  `@/lib/db` mock pattern (`src/lib/admin/crm-queries.test.ts:4-39`).
- FROZEN: `src/lib/ai` safety prompt text + `output-guardrail.ts` regexes.
- Tenancy: every query scopes by organizationId.
- Public repo: no PII, no operator dollar aggregates, anywhere.
- FieldPulse API: GET-only.
- Every behavioral fix ships a test that FAILS with the fix reverted.
- Gate per task: `npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 ·
  `npx vitest run` ≥ baseline · `node scripts/agent/verify-skills.mjs` → 0
  missing (Wave-2 skill task especially).

## Wave 0 — migrations (SERIAL, one actor)

**T0. Author 0045 + 0046 via two schema states** (SPEC §1.2/§1.3/§7-dev).
Edit 1: `src/lib/db/schema.ts` — KEEP the two old contact uniques, ADD the two
native-partial uniques + two lookup indexes → `npm run db:generate` → expect
`drizzle/0045_*` = exactly 4 CREATEs, 0 drops; re-generate → "No schema
changes". Commit. Edit 2: delete the two old uniques → generate → `0046_*` =
exactly 2 DROPs; re-generate → "No schema changes". Commit. **If either
artifact has a different shape, STOP** (SPEC §1.3 stop rule) — do not
hand-edit generated SQL. Do NOT apply to dev yet (Wave 4 does that, after all
code lands).

## Wave 1 — parallel build (disjoint file sets)

**T1. Resolver + pick order + crm-queries surgery.**
Files: `src/lib/admin/crm-queries.ts`, NEW `src/lib/admin/customer-match.ts`
(pure: `pickCustomerMatch`, the candidate-query predicate constant, the
`pg_indexes` abort predicate), `src/lib/admin/crm-queries.test.ts`, NEW
`customer-match.test.ts`.
Changes per SPEC §1.4 (new `targetWhere`), §3.2 (candidate SQL with rule-1
filter in WHERE, ordering + LIMIT 50, `{id, ambiguous, doNotService} | null`;
`findCustomerIdByContact` keeps its `string | null` shape; new
`findCustomerMatchByContact` carries the flag and writes the
`ambiguous_do_not_service_refusal` audit row per §3.3 rule 3), §3.5
(un-archive gate site 1 JS + site 2 SQL CASE; legacy-scan
`fieldpulse_customer_id IS NULL` narrowing; `updateCustomerContact` clash
narrowing + wrapped SET mapping `isUniqueViolation` → `contact_conflict`).
Revert-tests: §6 items — pick-order table, ambiguity, un-archive gate, legacy
narrowing, clash mapping.

**T2. Import machinery: flag + flagged resolution.**
Files: `src/lib/integrations/fieldpulse/import/customers.ts`,
`src/lib/integrations/fieldpulse/import/run-import.ts`, their test files,
NEW pure module if §6 places `resolveFpCustomerAction` separately.
Changes per SPEC §2.0 (flag parse → `PhaseContext`; unflagged = legacy path
byte-for-byte + `sharedContactSkipped` on the fp-id-guard branch, non-null
return preserved — the `jobs.ts:424-428` contract; phase-level two-index
`pg_indexes` probe, loud abort), §2.1 (flagged resolution: email-only claim
with claim-pick polarity, per-run claimed map + contested→insert, path-2
re-select repair, erasure guard untouched), §2.2, §2.3.
`importOneFpCustomer` gains the optional opts param — verify `jobs.ts:389`
call site needs no change and `jobs.test.ts:641` still passes (exact-arity
check is on the 2-arg call, which is unchanged).
Revert-tests: §6 — `resolveFpCustomerAction` table (flagged-path only),
`sharedContactSkipped` + non-null default return, probe predicate,
predicate-constant guard test.

**T3. Invoice/estimate residual instrumentation.**
Files: `src/lib/integrations/fieldpulse/invoice-sync.ts`,
`src/lib/integrations/fieldpulse/import/invoices.ts`, their tests.
Changes per SPEC §4.2: optional `onUnlinked` callback on
`upsertInvoiceRecord` (webhook/cron callers unchanged); import loop wires
`unresolvedFpCustomerIds` + `unlinkedInvoices` onto `PhaseResult`.
NOTE: `PhaseResult` type lives in run-import.ts (T2's file) — T3 only READS
the type; coordinate by having T2 land the three counter fields, T3 rebase on
it (T3 starts after T2's commit; it is Wave 1.5 in practice — run T3 after T2
completes, in parallel with nothing that touches its files).

**T4. Background fp-id adoption pre-check.**
Files: `src/lib/integrations/fieldpulse/customer-sync.ts`,
`src/lib/integrations/housecall-pro/customer-sync.ts`, tests.
Changes per SPEC §5 row (pre-check whether the FP-returned id is already
claimed; skip adoption with a log when it is — kills the silent permanent
retry). Revert-test: adoption skipped when id taken.

**T5. Erasure sibling disclosure.**
Files: `src/lib/admin/erasure-queries.ts`,
`src/app/api/admin/customers/[id]/erase/route.ts`, the customers detail page
confirm UI, tests for the query helper (route/UI logic stays thin; extract
the sibling-listing as a tested query helper).
Changes per SPEC §5.1: list sibling rows sharing either hash (id + server-side
decrypted name) in the erase confirmation; erase itself stays per-row.

## Wave 2 — consumers of T1's resolver (parallel, after T1)

**T6. Chat/voice identity blanking.**
Files: `src/lib/ai/customer-context.ts`, tests.
Changes per SPEC §3.3 rule 2 + §5: ambiguous → exact blanking enumeration
(keep customerId/doNotService/customerType; isReturning=false,
priorRequestCount=0, membershipStatus=null — widen type to `string | null`,
lone consumer `customer-context.ts:280` verified null-safe; firstName,
fullName, hcpCustomerId = null). `resolve-voice-identity.ts`: NO change
(pure delegate). Revert-test: ambiguous input → blanked context, id kept.

**T7. SMS consent asymmetry.**
Files: `src/lib/communication/consent.ts`, tests.
Changes per SPEC §3.5: STOP fans out to all phone-hash matches via
`db.batch()`; START resolves ONE row via T1's resolver with the START pick
(most-recently-active live non-blocked — skip rule 2) and touches only it.
Revert-tests: STOP fan-out; START single-row.

**T8. Docs + skills.**
Files: `.claude/skills/page-customers/SKILL.md` (per SPEC §5),
`docs/customer-identity-program/` updates if any task surfaced deltas.
Gate: `verify-skills.mjs` → 0 missing.

## Wave 3 — integration gate (SERIAL)

Full `npx tsc --noEmit`, `npx eslint` on all changed files,
`npx vitest run` ≥ 322/4,279/1, `verify-skills`. Fix anything; commit.

## Wave 4 — dev backfill + verification (SERIAL, lead runs it; SPEC §4/§4.1)

1. Apply migrations on dev: `npm run db:migrate`; verify via pg_indexes
   SELECT (SPEC §4 step 1) — new indexes present, old uniques gone.
2. `npm run fp:import -- --org <uuid> --phase customers --yes
   --split-shared-contacts`. Expect: created ≥ ~357 (census identity is an
   inequality — SPEC §4.1), errors 0 (the 9 gone), `sharedContactSkipped` 0.
3. `--phase jobs` (self-heal touch-up), then `--phase invoices`, then
   `--phase estimates`.
4. `node scripts/agent/reconcile-fieldpulse-money.mjs --org <uuid>` → exit 0.
5. §4.1 checks: FP-invoice orphans 501 → upstream-deleted residual only
   (quantified via `unresolvedFpCustomerIds`); unpaid orphans 94 → small;
   estimates orphans (baseline 2/36) → 0; duplicate-hash groups now > 0 and
   stable; native rows ≤ 9.
6. Record before/after in `docs/customer-identity-program/RESULTS.md`
   (counts and mechanisms only — no dollar figures).

**Deliberately NOT in this program** (SPEC §8): prod deploy; prod backfill and
the §4.5 prod state review; editing `.github/workflows/fp-nightly-sync.yml`
(the steady-state flag flip happens only after a future prod migration +
backfill — flipping now would abort nightly customer sync against prod's
un-migrated schema); force-create UI; discount modelling; HCP pulls.

## Final — adversarial code review

Two blind critics over the full diff (correctness+safety lens, spec-fidelity
lens: does the code do what SPEC says, exactly). Fix verified findings; rerun
Wave-3 gates; commit.

## Risk register

| Risk | Catch |
|---|---|
| drizzle-kit emits a different migration shape than §1.3 expects | T0's explicit shape check + stop rule |
| ON CONFLICT arbiter mismatch only fails at runtime (42P10) — unit tests mock the DB | Wave 4 step 2 exercises the real insert path on dev; plus a one-shot dev intake smoke after migrate (create a throwaway native customer via `upsertCustomerByContact`, then hard-delete it) |
| `jobs.test.ts:641` exact-arity assertion breaks on signature change | T2 explicitly verifies the 2-arg call site is unchanged |
| Vitest baseline drift from parallel waves | Baseline pinned above; every task gate re-runs the full suite |
| T3 races T2 on `PhaseResult` | T3 is sequenced strictly after T2's commit |
| Unflagged nightly behavior accidentally altered | T2's revert-test pins non-null return + counter-only delta on the legacy path |
