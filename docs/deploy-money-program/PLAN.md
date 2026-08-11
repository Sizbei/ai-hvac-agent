# Implementation plan

From the four specs in `specs/`, with round-1 review applied. Facts in
`FACTS.md`; deploy procedure in `DEPLOY-RUNBOOK.md`.

## Reviser decisions

| Finding | Decision |
|---|---|
| **Evidence E — 512 invoices have no customer; 11 are `open` and carry $[redacted] of real on-screen AR** with no route to a customer profile and no reminder capability. No spec owned this. | **Accepted → M2.** This is the user's exact question ("is the information right?") answered in the negative: the AR total includes money the product cannot act on. Surface it rather than let it sit invisible. |
| **Evidence E — `deployment-strategy.md`'s central P0 (7 commits unpushed, CI never run) is stale.** | **Accepted.** It was true when drafted and I resolved it mid-program: pushed, CI run `31419465582` green. Then an agent deployed without authorisation (see FACTS.md incident). The spec's forcing function is spent — struck, not built. |
| Evidence E — the five high-stakes claims (qty-0 coercion, `total_cents` matches live 30/30, re-pull idempotency, crons fail closed, CI blocking set) all re-verified true on independent samples. | **No action.** Recorded so the next session doesn't re-litigate them. |
| Scope lens (covered by me — the scope critic hung after ~9h and was stopped; per the review protocol a stalled mechanism must not strand the round). | See the four scope judgements below. |
| **Scope — do NOT build a second scheduler.** `sub-daily-crons.yml` already pings cron endpoints every 5 min, and `fp-nightly-sync.yml` already runs the full FieldPulse sweep. | **Rejected any new scheduling system.** The user asked to "set up a cron job"; the honest answer is that the need is already met, and the right work is to close two coverage gaps in what exists (S1, S2). |
| **Scope — do NOT build an HCP backfill pipeline.** There is no `run-import.ts` equivalent for Housecall Pro, and no key. | **Rejected as manufactured work.** Building a backfill for an integration that cannot authenticate is speculative. Document readiness only. |
| **Scope — do NOT configure a FieldPulse webhook secret blind.** Both FP webhook routes fail closed 401 because no secret is set anywhere. | **Rejected for this run, escalated to the user.** FieldPulse exposes no subscription API, so there may be no vendor-side webhook to receive. Setting a secret to satisfy a spec would create the appearance of a working webhook that nothing calls. Needs a fact only the user can get from their FieldPulse account. |
| Money G4 (UTC vs Eastern month boundaries), G6 (FACTS' broader AR definition), G7 (draft line items) | **P2 — backlog.** Recorded, not built. |

## Committed scope

### Money correctness

| id | Requirement | Change |
|---|---|---|
| M1 | `Rmoney-3` | FieldPulse sends `quantity: "0"` to mean "flat quoted price". `client.ts:613-614` coerces that to `qty=1`, so `invoice_line_items.lineTotalCents`/`costCents` inflate and the invoice detail page's margin roll-up is wrong. Verified live on FP#20820875 (`"quantity":"0","unit_price":"5500.0000"` → phantom $5,500 line). Header `total_cents` is unaffected — it comes straight from FieldPulse's own `total`, which is why AR is still correct. Preserve the flat-price meaning instead of fabricating a quantity. |
| M2 | **new (evidence review)** | 11 `open` invoices totalling **$[redacted]** have `customer_id IS NULL`: they count toward AR but have no customer profile and no reminder path. Make them visible and countable so the operator can tell collectible AR from stranded AR. Do NOT silently exclude them from AR — that would trade one wrong number for another. |
| M3 | `Rmoney-2` | 3 invoices are `state='paid'` while still owing (~$630). They predate the guard that now prevents this and were never corrected. One-off reconcile, forward guard already shipped (B7). |

### Scheduling coverage

| id | Requirement | Change |
|---|---|---|
| S1 | `Rsync-2` | `process-communications` — the single chokepoint for every automated customer message — is scheduled ONLY by the GitHub Actions 5-min ping. It is absent from `vercel.json`. A GH Actions outage, quota exhaustion or secret drift silently stops all customer messaging with no fallback. Add a daily Vercel-native backstop. |
| S2 | `Rsync-3` | `reconcile-payments` heals stranded post-charge payments but runs only daily on Hobby, so a stranded payment can display wrong for ~24h. Add it to the existing 5-minute Actions pinger — reusing the pattern already in the repo, not inventing one. |

### Operability

| id | Requirement | Change |
|---|---|---|
| O1 | `Rpull-3` | Two `fp_import_runs` rows sat at `status:'running'` for 18 days and were fixed by a manual UPDATE. Nothing reaps them, so the import page polls "Running" forever and hides its Refresh button. Add stale-run detection (the UI half shipped in the page program; this closes the data half). |
| O2 | `Rdeploy-*` (docs) | `MIGRATIONS.md` and `docs/DEPLOYMENT.md` both contradict `vercel.json`'s real `db:migrate && next build` buildCommand. An operator following them during an incident would take the wrong action. Correct them, and link `DEPLOY-RUNBOOK.md`. |

### Data

| id | Work |
|---|---|
| R1 | Run the FieldPulse re-pull **into the DEV branch only**. Dev forked 2026-07-09 and froze (`updated_at` pinned 2026-07-08); it is ~390 customers behind. Production is already swept nightly by `fp-nightly-sync.yml` (successful runs through 2026-08-10), so prod needs nothing. Re-run is proven idempotent for money across all 11 phases — both money tables upsert through per-org partial unique indexes, and FP payments are excluded from revenue aggregates by `fieldpulsePaymentId IS NULL` guards. |

## Not being built (with reasons)

- **Housecall Pro re-pull** — no API key, 0 connection rows, and no backfill
  pipeline exists. Blocked on a credential only the user can supply. The
  connect route is already built and ready.
- **FieldPulse webhook subscription** — the vendor exposes no subscription
  endpoint (8 candidate paths probed, all 403). Not possible.
- **FieldPulse webhook secret** — see reviser decisions; needs a fact from the
  user's FieldPulse account.
- **A new scheduler / new cron job** — already covered by existing workflows.
- **Vercel Pro upgrade** — a real option (precise sub-daily native crons, any-
  deployment rollback instead of one-step-back), but a spending decision that
  is the user's to make. Documented, not assumed.
- Money P2s: UTC-vs-Eastern month boundaries, draft line-item display hazard.

## Gates

`npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 · `npx vitest run` → not
below **321 files / 4239 passed / 1 skipped** · `verify-skills` → 0 missing ·
page skills updated in the same change.

Untouched: FROZEN `src/lib/ai` safety text and guardrail regexes, tenancy
scoping, `db.batch()` over `db.transaction()`, `after()` over detached
promises, synced-invoice read-only money guards.
