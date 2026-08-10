# SPEC — Money-integrity audit (invoices, AR, collected, reports)

## 1. Purpose

The user's highest-priority ask: adversarially check the invoice and money
pages "as much as possible to make sure all the information seems right."
The central question is not code tidiness — it's whether the dollar figure
an operator reads on `/admin/invoices`, `/admin/accounting`, `/admin/reports`,
`/admin/operations`, and the dashboard tile is TRUE. This spec is the audit
plan, grounded in probes already run against the live FieldPulse API
(read-only GET) and the DEV Neon branch (read-only), not a hypothetical.
Where a probe was feasible it was run to completion; where the task scope
calls for a fuller sweep (all 2,853 invoices against live FP), the exact
query/script is specified so it can be run as Rmoney-1.

## 2. Brainstorm (considered and rejected)

- **Full 2,853-invoice live reconciliation during spec-writing** — rejected
  for this pass: a 30-invoice stratified sample (largest-open, most-recent,
  random-paid, random from the due<issued anomaly set) already surfaced every
  defect class found; running all 2,853 is Rmoney-1, not spec-work.
- **Comparing against the PROD database directly** — rejected: the task's
  hard constraint is DEV-branch-only (`.env.local`, `ep-patient-surf-…`),
  never `ep-withered-hill`. A real limitation, called out in §4/§6, not
  worked around.
- **Re-running the FieldPulse sync/backfill to "fix" DEV during this audit**
  — rejected: read-only mandate. Fixing is a follow-up change, not this
  spec-writing pass.
- **A tolerance band for reconciliation ("within $1 is fine")** — rejected.
  Every FP total sampled matched to the cent (30/30); money is integer cents
  throughout the schema (verified: `pg_typeof(total_cents) = integer`).
  **Acceptable tolerance for `total_cents`: zero.** (See Rmoney-1.)
- **Auditing the payments provider/Stripe integration** — rejected: no
  Stripe keys configured (`provider = "mock"` only); FieldPulse is the only
  real money source today. Out of scope, not a gap.
- **Rebuilding `subtotalCents` from summed line items instead of
  `totalCents − taxCents`** — considered as a "fix" for the line-item
  mismatch (§4 G3), then rejected: the documented design
  (`invoice-sync.ts:354-357`) exists because FP's raw subtotal is
  pre-discount and doesn't reconcile. The header total is right; fix the
  line-item import, not the header formula.
- **A generic "add more tests" requirement** — rejected: every requirement
  below names the exact query/assertion instead.

## 3. Current state (evidence-grounded)

### 3.1 Definitions are single-sourced across surfaces — `verified`

- `overdueWhere()` (`src/lib/admin/invoice-queries.ts:44-49`) is the ONE
  overdue predicate: `dueDate < now() - 1 day` when set, else
  `coalesce(issuedAt, createdAt) <= now() - 30 days`. Imported and reused
  verbatim by the dashboard tile (`queries.ts:40,1207-1212`, comment says
  "never a second 'overdue' definition") and `getInvoiceSummaryStats`
  (`invoice-queries.ts:890-917`).
- AR ("outstanding") is defined identically in three places as `state='open'
  AND amount_paid_cents < total_cents`, split native/synced by
  `fieldpulseInvoiceId`/`hcpInvoiceId`: `invoice-queries.ts:910-917`,
  `reporting-queries.ts:141-155`, `operations-metrics-queries.ts:258-267,
  286-294`. Same WHERE-clause shape against the same table at query time —
  structurally guaranteed to agree, not just observed to. Real fix from
  `docs/superpowers/plans/2026-07-11-pagination-ar-fp-expand.md` (reports
  once lacked the `amount_paid < total` guard; operations once summed
  native-only and printed `$0`).
- `age`/`sort` everywhere use `coalesce(issuedAt, createdAt)`, never raw
  `createdAt` — confirmed across `invoice-queries.ts`,
  `accounting-export.ts:36-38`, `operations-metrics-queries.ts:253-255`.

### 3.2 Live probe: `total_cents` matches FieldPulse 30/30 — `verified`

30 invoices were sampled from the DEV DB (10 largest open-balance, 10 random
`paid`, 10 random from the "due_date before issued_at" anomaly set) and
fetched live via `GET {base}/invoices/{fpId}` (`x-api-key` header, per
`src/lib/integrations/fieldpulse/config.ts:17`), using the existing
`RestFieldpulseClient.getInvoice()` (read-only). Result:

**`total_cents`: 30/30 exact match, zero mismatches.** The invoiced amount
— the number that ultimately drives AR — is correct. `amount_paid_cents`
and `tax_cents` disagreed on 5/30 and 20/30 respectively; both are
explained in §3.3, not by a total-cents error.

### 3.3 DEV mirror is ~1 month stale; PROD freshness is unverified — `verified` (staleness) / `inferred` (root cause) / `unverified` (PROD)

- Every FieldPulse-sourced invoice in DEV has `updated_at` = **exactly
  2026-07-08** (probe: `select date(updated_at), count(*) from invoices
  where fieldpulse_invoice_id is not null group by 1` → single row, 2,849).
  No row has been touched since.
- `vercel.json` cron `sync-fieldpulse-invoices` runs daily at 11:00 UTC
  against Vercel's **Production** `DATABASE_URL` only — DEV (`.env.local`)
  is never the target of a deployed cron. DEV was forked from prod on
  2026-07-09 (`neon-db-environments` note) and, per this probe, has not
  been synced since.
- This fully explains both live-vs-local disagreement classes:
  - **`amount_paid_cents` (5/30 mismatches, all understating collections):**
    e.g. FP#20824732 local `paid=0`, live `paid=$10,307.15` (fully paid);
    FP#20824903 local `paid=0`, live `paid=$4,430.46`; three more of similar
    shape — invoices FP shows SETTLED that DEV still counts as open AR
    because they were paid sometime in the last month, after DEV's last sync.
  - **`tax_cents` (20/30 mismatches, all $0 locally vs a real tax value
    live):** `invoice-sync.ts:350-353` documents tax capture as a fix
    (">0 on ~56% of invoices"); rows synced before that fix, never re-synced
    since, still carry the pre-fix `$0`.
- **What this does NOT explain:** whether PROD (which the daily cron does
  reach) is actually current. This audit could not check — the task's hard
  constraint is DEV-only. Flagged as a verification gap, not a PROD bug
  (see §4, G1).

### 3.4 The `$[redacted]` vs `$[redacted]` delta, explained — `verified` (DEV figures) / `inferred` (full explanation)

Four DEV-side AR figures, computed directly:

| Definition | Query | Result |
|---|---|---|
| Product code's actual AR (`state='open' AND paid<total`, all 3 surfaces) | `invoice-queries.ts:910-917` shape | **$[redacted]** (135 invoices) |
| FACTS.md's stated "non-void, total−paid" (nets overpaid rows negative) | `sum(total-paid) where state!='void'` | **$[redacted]** (2,853 rows) — matches FACTS.md exactly |
| Same broad filter, positive balances only | `... and total>paid` | $[redacted] (138 invoices) |

So the `$[redacted]` cited in FACTS.md is real and reproducible, but it is
**not what any product surface displays** — a broader ad-hoc definition
(includes `draft`/`refunded` states, nets negative/overpaid balances) than
the app's actual `state='open'` AR. The number an operator sees today is
**$[redacted]** — a documentation-precision gap (§4 G6), not a code defect.

The larger gap — DEV's **$[redacted]** today vs the **$[redacted]** recorded
against PROD on 2026-07-11 (`pagination-ar-fp-program` memory, itself
cross-checked against live FP then, "agreed to $11.20") — is best explained
by real branch divergence: DEV forked 2026-07-09 and has been frozen since
(§3.3); PROD received a full month of daily `sync-fieldpulse-invoices` cron
runs plus real invoicing/collection activity (FACTS.md separately confirms
DEV is ~390 customers behind live FieldPulse — broadly stale, not just
invoices). DEV also still holds 4 native test invoices deleted from PROD in
the 2026-07-09 cleanup (`neon-db-environments` note) — a small additional
contributor. **This audit cannot fully attribute the $[redacted] difference to
exact causes without querying PROD**, which is out of scope by constraint —
recommended as a requirement, not resolved here (Rmoney-1).

### 3.5 Internal consistency — `verified`

- **Header math (`subtotal + tax = total`): 0 violations** across all 2,853
  invoices (probe: `subtotal_cents + tax_cents != total_cents` → 0 rows).
- **Overpaid (`amount_paid_cents > total_cents`): 57 rows**, total excess
  $204.25 (avg $3.58), all `state='paid'` (e.g. FP#20824406: total $672.90,
  paid $677.35) — plausibly a FieldPulse-side card surcharge not reflected
  in `total_cents`. Immaterial and excluded from AR, but an unguarded
  invariant violation (§4 G5).
- **`state='paid'` with balance > 0: 3 rows**, $630.00 owed total
  (FP#20807625 $175, FP#20776752 $405, one native row $50). Exactly the
  failure mode the H2 guard at `invoice-sync.ts:361-365` (`state==='paid' &&
  rawAmountPaidCents===0 → correct to totalCents`) exists to prevent — these
  3 predate the guard and were never re-synced. AR only counts
  `state='open'`, so this $630 is currently invisible to collections (§4 G2).
- **Orphaned `customer_id`: 0. Negative amounts: 0. `amount_refunded_cents >
  amount_cents`: 0. Near-INT32_MAX: 0** (largest invoice $40,834.38, far
  under the 2,147,483,647-cent ceiling).
- **`payments.amount_cents` vs `invoices.amount_paid_cents` for FP-synced
  invoices:** 2,262 invoices have ≥1 succeeded imported (record-only)
  payment; **2,261/2,262 sum exactly** (1 mismatch, $333.43). Independently
  confirms `import/payments.ts:38-41`'s claim ("2,363 imported payments sum
  EXACTLY to amount_paid_cents", live-proven 2026-07-09) still holds a
  month later, at 99.96%.
- **Line items vs `subtotal_cents`: 1,780/2,853 invoices mismatch** (1,632
  of 2,389 non-draft; 1,169 by >$10). Root-caused on FP#20820875 (local
  `273dada2…`): FieldPulse's `quantity: "0"` line convention ("flat quoted
  price, don't multiply") is coerced to `qty=1` by
  `src/lib/integrations/fieldpulse/client.ts:613-614`
  (`parsedQty > 0 ? parsedQty : 1`), turning a $0-contribution line into a
  phantom $5,500 charge: local 3-line sum $6,559.75 − the phantom $5,500 =
  $1,059.75, FP's real total — exact match, confirming the mechanism.
  **`total_cents` is unaffected** (sourced from FP's `total` field directly,
  `invoice-sync.ts:348`). What IS affected: `invoice_line_items.costCents`/
  `lineTotalCents`, feeding `rollUpMargin(invoice.lineItems)` on the invoice
  detail page (`invoice-detail-client.tsx:323`) — an admin-facing
  margin/revenue figure is inflated wherever this pattern occurs (§4 G3).
  Most `draft` invoices (464, all `$0` total) also carry nonzero line
  items — cosmetic (drafts are excluded from every money figure) but a
  display hazard if ever rendered (§4 G7).

### 3.6 Boundary/timezone correctness — `verified`

- `collectedThisMonthCents` (`invoice-queries.ts:781-803`) computes the
  month boundary with `Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)`
  — pure UTC. The accounting export's "full day" bounds are literal
  `T00:00:00.000Z`/`T23:59:59.999Z` (`page-accounting` skill) — also pure
  UTC.
- The codebase has an established pattern for exactly this problem
  elsewhere: `after-hours.ts:9` ("All time math is done in the ORG's
  configured IANA timezone"), default `America/New_York`
  (`after-hours.ts:44`); `arrival-window.ts:35,69-70` does the same for
  scheduling. The business is Johnson City, TN (Eastern) per
  `spears-services-brand` memory. Money boundaries don't follow this
  pattern — raw UTC is 4-5 hours offset from Eastern wall time, so a
  payment/invoice after ~7-8 PM Eastern lands in the UTC-next-day bucket.
  **No live-data instance of an actually-misclassified transaction was
  found** (would require inspecting exact near-boundary timestamps, not
  done) — a structural risk, not a proven-wrong number today (§4 G4, P2).
- `overdueWhere()`'s 1-day grace interval absorbs the skew — not at risk.

## 4. Gaps

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | DEV mirror's `amount_paid_cents`/`tax_cents` are stale ~1 month vs live FieldPulse; whether the daily cron keeps PROD current is **unverified** (DB constraint: DEV-only) | P1 | §3.3; `updated_at` single-date cliff (2026-07-08); 5/30, 20/30 live mismatches, both staleness not calc error |
| G2 | 3 invoices are `state='paid'` with a real unpaid balance ($630 total); AR only counts `state='open'`, so it's invisible to collections. The H2 guard prevents this class but these 3 predate it | P1 | §3.5; `invoice-sync.ts:361-365`; probe → 3 rows |
| G3 | FieldPulse `quantity: "0"` lines ("flat quoted price") are coerced to `qty=1` by `client.ts:613-614`, inflating `invoice_line_items` sums that feed the invoice detail page's `rollUpMargin`. `total_cents`/AR unaffected | P1 | §3.5; FP#20820875 exact $5,500 phantom-line reconciliation; 1,169/2,389 non-draft mismatches >$10 |
| G4 | Money date boundaries use raw UTC, not the org's Eastern timezone tracked elsewhere (`after-hours.ts`, `arrival-window.ts`) | P2 | §3.6; `invoice-queries.ts:781-803` |
| G5 | 57 invoices overpaid by a small amount ($204.25 total) — unguarded, likely a FP-side card surcharge | P2 | §3.5; probe → 57 rows |
| G6 | FACTS.md's "$[redacted] outstanding" uses a broader definition than any product surface; the on-screen figure is $[redacted] | P2 | §3.4 |
| G7 | `draft` invoices (464, all `$0` total) carry real-dollar line items — display hazard if ever rendered | P2 | §3.5 |

No P0 found: no evidence of a currently-live code path corrupting a
headline collectible-money figure. `total_cents` — what AR, collected, and
overdue all derive from — matched live FieldPulse on every sample.

## 5. Requirements

- **Rmoney-1** (G1, §3.4): Run the same live-vs-local `total_cents`/
  `amount_paid_cents`/`tax_cents`/`issued_at`/`state` cross-check used in
  §3.2-3.3 against **all** FieldPulse-sourced invoices, on a schedule (e.g.
  weekly), and against PROD once read-only prod access exists.
  **Acceptance:** a script/report exists reporting mismatch count and $
  magnitude per field, run-able via `npm run`, safe against PROD (no
  writes); zero `total_cents` mismatches is the pass bar (tolerance = 0);
  `amount_paid_cents` mismatches are expected only for invoices paid since
  last sync and must be resolved by re-sync, not silently accepted.
- **Rmoney-2** (G2): Add a query/alert (dashboard banner, cron check, or
  audit-log entry) surfacing any invoice where `state='paid' AND
  amount_paid_cents < total_cents`. **Acceptance:** a test asserts the
  query returns 0 rows on a fixture where this state is impossible, >0 on
  one that reproduces it; wired into the invoice list or a monitoring
  surface, not just documented.
- **Rmoney-3** (G3): Fix `toLineItems()` (`client.ts:613-614`) to treat
  FieldPulse `quantity: "0"` as a real zero, not `qty=1`. **Acceptance:** a
  unit test with the exact FP#20820875 shape (3 components, first
  `quantity: "0"`) asserts `sum(lineTotalCents) === invoice.subtotalCents`;
  existing fractional-quantity tests (7.5, 4.13) keep passing. Re-syncing
  already-imported rows is noted but out of scope for this fix's
  acceptance.
- **Rmoney-4** (G1/§3.4, non-code): Document, in FACTS.md or a successor
  note, that DEV money figures are a point-in-time snapshot (last synced
  2026-07-08) and must not be quoted as "current" without re-verifying
  against a live source. **Acceptance:** the note exists and is referenced
  by any future spec citing a DEV-derived dollar figure.

G4-G7 (all P2) do not become requirements per "only P0/P1 become
requirements" — noted for awareness, not scheduled.

## 6. Non-goals

- Verifying PROD's live money figures — blocked by the DB-DEV-only
  constraint; flagged as unverified in G1/Rmoney-1, not assumed fine.
- Fixing the gaps in this pass — this is a spec; G1-G7 are findings,
  Rmoney-1..4 define the fix's acceptance criteria.
- Auditing Housecall Pro money paths — `housecall_pro_connections` has 0
  rows (FACTS.md); no live HCP data to reconcile against. HCP-shaped code
  is structurally identical to the audited FieldPulse paths and
  degrade-safe by design; re-audit when a real HCP key exists.
- Auditing the Stripe/payments-provider integration — not configured
  (`provider="mock"` only); no real charges to reconcile.
- Reconciling `estimates` pipeline dollar figures — out of scope; this spec
  is invoices/AR/payments only, per the task's framing.
- A full walk of all FieldPulse invoices via `/invoices` list pagination —
  the endpoint's `total_count` is null by design (`client.ts:172-173`,
  sized by walking until empty); a full walk is Rmoney-1's job.

## 7. Invariants

(Restating what §3's evidence shows already holds, and must keep holding —
not new rules.)

- `total_cents` on a FieldPulse-mirrored invoice must always equal FP's own
  `total` field, verbatim, in cents; no local recomputation from line items
  ever overrides it (§3.2, §3.5).
- AR, overdue, and collected figures on `/admin/invoices`,
  `/admin/accounting`, `/admin/reports`, `/admin/operations`, and the
  dashboard tile must be computed from the single shared
  `overdueWhere()`/`state='open' AND paid<total` predicates — never a
  second, surface-local definition (§3.1; the exact bug class the
  2026-07-11 program already fixed once).
- Synced (FieldPulse/HCP) invoices remain read-only in all native money
  mutation paths — unaffected by this audit, reconfirmed by
  `page-invoices/SKILL.md`'s existing invariant list.
- `amount_paid_cents` must never structurally exceed `total_cents` silently
  (G5 shows small real-world exceptions exist and are currently
  unexplained/unguarded — the invariant is the goal, not yet enforced).

## 8. Verification

- Re-run the exact SQL in §3.4/§3.5 (documented inline, not committed as a
  script per the read-only/no-new-files constraint) against DEV after any
  fix lands: confirm G2's "3 rows" → 0 and G3's "1,169 >$10 mismatches"
  materially shrinks (full 0 requires re-sync, not just the code fix).
- Re-run the §3.2 live cross-check (30-sample, or the full walk once
  Rmoney-1 exists) after any re-sync to confirm `amount_paid_cents`/
  `tax_cents` mismatches drop to the "paid since last sync" residual only.
- `npx vitest run` must stay ≥ the 321-file/4,239-pass/1-skip baseline
  (FACTS.md gate) — Rmoney-3 is a pure-function change in `client.ts`,
  testable without DB/network per existing `client.test.ts` patterns.
- Any Rmoney-2 alert should be checked against a fixture invoice forced
  into `state='paid', amount_paid_cents < total_cents` (test-only, never
  real DEV data) to confirm it fires.
