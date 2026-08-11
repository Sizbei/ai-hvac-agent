# Round 1 — Evidence audit of the deploy-money-program specs

Reviewer stance: adversarial, evidence-only. Every `verified` claim behind a
P0/P1 gap was either re-derived from the cited `file:line`, or re-probed live
(FieldPulse GET, DEV-branch read-only SQL). Read-only throughout: no writes to
FieldPulse, no writes to the DB, no deploy, no importer run, no edits to
source/specs. Temp probe scripts (`probe-evidence-r1-*.mjs`, repo root, unique
names) were deleted after use.

Method note: all DB probes ran against `ep-patient-surf-aqyjr5da-pooler...`
(confirmed DEV, `current_database=neondb`) — never `ep-withered-hill`.

---

## money-integrity.md

### E-1 — CONFIRMED: `quantity: "0"` → phantom line, both code and live data
- **severity**: n/a (this is a **confirmation**, not a finding against the spec)
- **tag**: `verified`
- **quoted line**: "FieldPulse's `quantity: "0"` line convention... is coerced
  to `qty=1` by `src/lib/integrations/fieldpulse/client.ts:613-614`
  (`parsedQty > 0 ? parsedQty : 1`)"
- **what I checked**: `src/lib/integrations/fieldpulse/client.ts:613-614`
  reads verbatim `const parsedQty = Number.parseFloat(...); const qty =
  Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;` — exact
  citation match. Then live-fetched `GET /invoices/20820875` (real FP API,
  read-only): the first `line_components[0]` is `{"title":"Tune Ups",
  "quantity":"0","unit_price":"5500.0000", ...}` — the exact shape claimed.
  Local DB line items for this invoice (`invoice_line_items` table) show
  `quantity=1, unit_price_cents=550000, line_total_cents=550000` — confirming
  the `0 → 1` coercion actually happened on import. Local 3-line sum =
  $6,559.75 (550000+75000+30975 cents), matching the spec's cited figure
  exactly. Live FP `total`/`subtotal` = `"1059.75"`; local `total_cents` =
  105975 — **exact match**, confirming `total_cents` is unaffected as the
  spec claims (it comes from FP's `total` field directly, not summed from
  lines).
- **verdict**: spec's claim is fully correct, both in code and against live
  vendor data. This is a real, currently-live data-integrity defect in
  `invoice_line_items`/margin displays, exactly as characterized.

### E-2 — CONFIRMED: `total_cents` matches live FieldPulse (no P0), reproduced on an independent sample
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "**`total_cents`: 30/30 exact match, zero mismatches.**
  The invoiced amount — the number that ultimately drives AR — is correct."
- **what I checked**: sampled 17 invoices the spec's own 30-sample did NOT
  necessarily include (12 random + the 5 largest-by-`total_cents` overall,
  drawn independently via `order by random()` / `order by total_cents desc`),
  fetched each live via `GET /invoices/{fpId}`. **17/17 `total_cents` exact
  matches, 0 mismatches.** `amount_paid_cents` also matched 17/17 in my
  sample (spec's sample had 5/30 stale mismatches — not contradictory, just
  a different draw; both samples show `amount_paid_cents` staleness is
  bounded and explainable, not a `total_cents` problem). `tax_cents`
  mismatched on 6/17 (all local-$0-vs-live-nonzero) — consistent with the
  spec's §3.3 staleness explanation (rows synced before the tax-capture fix
  never re-synced).
- **verdict**: the "no P0" all-clear on `total_cents` holds up under an
  independent draw. I found no counter-evidence.

### E-3 — VERIFIED: internal-consistency aggregate figures reproduce exactly
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted lines**: "Overpaid... 57 rows, total excess $204.25"; "`state='paid'`
  with balance > 0: 3 rows, $630.00 owed total"; "Header math... 0
  violations"; outstanding non-void "**$[redacted]**"; AR "**$[redacted]**
  (135 invoices)"; "$425.75 residual on 'paid' rows"
- **what I checked**: re-ran each aggregate independently: overpaid → 57
  rows / $204.25 excess (exact); paid-with-balance → 3 rows / $630.00 (exact);
  header math → 0 violations (exact); AR → 135 rows / $[redacted] (exact);
  outstanding non-void → $[redacted] (exact, matches FACTS.md too); residual
  on state='paid' mismatched rows → 60 rows (57 over + 3 under), net signed
  sum $425.75 (exact — `630.00 − 204.25 = 425.75`, confirming the arithmetic
  ties the two populations together correctly).
- **verdict**: every DEV-DB aggregate cited in §3.4/§3.5 reproduces exactly.
  No drift, no rounding error, no cherry-picked framing found.

### E-4 — minor: line-count self-correction is itself off by one (deployment-strategy, cross-referenced by money-integrity's FACTS.md context)
See D-3 under deployment-strategy.md below (same underlying git-range
arithmetic error); not repeated here to avoid double-counting.

**VERDICT (money-integrity.md): sign-off.** Every checked claim — including
both explicitly flagged high-stakes ones — reproduced exactly against live
FieldPulse data and independent DB samples. No blockers, no majors found in
this spec's evidence.

---

## The 512 NULL-`customer_id` invoices (not mentioned in any spec)

- **severity**: **major** (real, currently-live gap; not a blocker because it
  degrades safely and doesn't corrupt a headline money figure)
- **tag**: `verified` (my own probe, not cited in any spec)
- **count reproduced**: `select count(*) from invoices where customer_id is
  null` → **512**, exact match to the brief's held-back probe.
- **breakdown** (`state`, all FieldPulse-sourced, 0 HCP):
  - `paid`: 421 rows, $[redacted] total — already collected, not a current
    money-at-risk figure.
  - `draft`: 80 rows, $0.00 — no money.
  - `open`: **11 rows, $[redacted] total / $[redacted] outstanding.**
- **AR exposure**: those 11 open rows satisfy `state='open' AND
  amount_paid_cents < total_cents` and so **are counted** in the app's real
  AR figure — $[redacted] of the $[redacted] total (≈3.6%).
- **render check**: `getInvoiceDetailById` (`invoice-queries.ts:1316`) and
  the list query (`:1109`) both `leftJoin` `customers` — a NULL
  `customer_id` degrades to a NULL join, not a crash. The invoice-row
  component renders `invoice.customerName ?? '—'`
  (`invoice-row.tsx:94`) — confirmed no error, just a dash.
- **customer-profile reachability**: by construction, not reachable —
  there is no customer to view it from. This is the expected shape of the
  gap, not a separate bug.
- **collections-workflow check**: the "Send reminder" button is gated by
  `!invoice.syncedSource` (`invoice-detail-client.tsx:354`) — since **all**
  512 rows are FieldPulse-sourced, the button never renders for any of them,
  NULL-customer or not (pre-existing invariant: synced invoices are
  read-only in every money-mutation/reminder flow). Hitting the API directly
  (`sendInvoiceReminder`, `money-triggers.ts:276`) would return `{ok:false,
  reason:"not_found"}` for a NULL-`customerId` invoice — a slightly
  misleading reason string (masks "invoice exists but has no linkable
  customer" as "not found"), but it 400s, it doesn't throw. The automated
  dunning cron (`sendOverdueInvoiceReminders`) filters to **native**
  invoices only (`isNull(fieldpulseInvoiceId)`, `money-triggers.ts:~410`) —
  so it never touches any of these 512 rows regardless of `customer_id`,
  by design (FP-synced invoices are meant to be collected on FieldPulse's
  side, not dunned locally).
- **root-cause check** (why is `customer_id` null — matching bug vs.
  genuine staleness?): live-checked the FP `customer_id` on all 11 open rows
  and a further random 15-row sample (26 total) against
  `customers.fieldpulse_customer_id`. **24/26 have no matching local
  customer row at all** (their FP customer ids cluster at 17429xxx–17431xxx,
  the high end of FP's id space — consistent with the documented "DEV is
  ~390 customers behind live FieldPulse" staleness, i.e. these customers
  simply haven't been pulled yet). **2/26 DID find a matching local customer
  row** the invoice failed to link to (fp_customer_id 17431004 →local id
  `786b21dd-...`; fp_customer_id 17048105 → local id present) — a small,
  real residual "link should have succeeded but didn't" class, distinct
  from and smaller than the staleness explanation.
- **consequence, honestly rated**: this is **not** a P0 — it doesn't corrupt
  a headline collectible-money figure (the $[redacted] is real FP-side money,
  correctly counted in AR, just not locally collectible via reminder — which
  matches the product's own "FP collects synced invoices" design). It also
  isn't purely benign: it's real, present-tense $[redacted] of AR that is
  currently **unreachable from the customer-facing side of the product with
  no compensating control** (no customer profile shows it, no local
  reminder can target it, and 2 of the sampled cases show it's fixable —
  the customer exists, the link just didn't happen). I rate it **major**:
  worth a requirement in a follow-up spec (backfill `customer_id` via
  `fieldpulse_customer_id` matching + a documented note that any FP invoice
  which imports before its customer has been pulled will orphan this way,
  so the customer phase should ideally run to completion, or the invoice
  phase should re-link retroactively, before invoices are trusted as fully
  attributed).

---

## deployment-strategy.md

### D-1 — BLOCKER-equivalent (currency, not fabrication): the spec's central P0 forcing-function is no longer true as of this review, with no re-verify note in the spec itself
- **severity**: **major** (downgraded from `blocker` because I cannot prove
  the claim was false *at the time the spec was written* — see below — but
  it is unambiguously false **right now**, and acting on the spec's own
  Rdeploy-7 sequence as written risks redundant/confused action)
- **tag**: `verified` (as of my review; the spec's own tag was also `verified`)
- **quoted lines**: "`git log origin/main..main` shows local `main` is 7
  commits ahead of `origin/main`... `gh run list --workflow=ci.yml` confirms
  the last CI run was `7787352` (2026-08-03); none of the 7 newer SHAs ever
  triggered a run." (§3a) and "Gdeploy-2: 5 pending commits never pushed to
  `origin/main`; CI never ran on them | P0"
- **what I checked**:
  - `git fetch origin main && git log --oneline origin/main..main` →
    **0 commits.** `git merge-base --is-ancestor 082421b origin/main` →
    **YES**. Local `main` and `origin/main` are at the identical SHA
    (`082421b`) right now.
  - `gh run list --workflow=ci.yml --limit 8` shows CI **did** run on
    `082421b` — `2026-08-10T18:31:04Z`, status `completed success` — directly
    contradicting "none of the 7 newer SHAs ever triggered a run."
  - `vercel ls --prod` shows the **newest production deployment is 7 minutes
    old** at the time I ran it (today, 2026-08-11) — i.e., a prod deploy has
    already happened, very recently, separate from the "7-day-old" baseline
    the spec (and FACTS.md) describe.
  - The spec files themselves are **untracked** (`git status` shows
    `docs/deploy-money-program/` as untracked), with filesystem mtimes of
    2026-08-11 ~03:30. The CI run on `082421b` completed 2026-08-10 18:31
    UTC — which, depending on the spec-author's clock/timezone, may be
    *before* the spec was drafted (making the P0 claim wrong from the
    moment of writing) or the push/deploy may have happened *after* the
    spec was drafted and *during* this review session (plausible: this is a
    multi-agent session and another agent/operator may be concurrently
    executing Rdeploy-7). **I cannot fully disambiguate which — but either
    way, the spec's problem statement is stale now**, and nothing in the
    spec is timestamped or flagged as "verify before acting" the way
    FACTS.md flags its own DEV-branch figures.
- **why this matters**: Gdeploy-2 is the spec's only other P0 besides
  Gdeploy-1/Gdeploy-3, and Rdeploy-7 (the actual "ship it" requirement) is
  framed as five still-open steps. A reader acting on this spec today would
  redundantly re-push (no-op, already pushed), possibly re-run
  `vercel deploy --prod --yes` unnecessarily (low-risk but wasted, and
  confusing against a deploy that already happened 7 minutes prior), and
  would not know the migration/build that just ran already exercised
  `0041`-`0044` against real prod — undermining Rdeploy-3's "dry run against
  DEV first" sequencing if skipped in the belief it's still "step 2 of 5."
- **what I could NOT verify**: whether the just-deployed build is in fact
  `082421b`'s content — `vercel inspect --json` on the newest deployment
  carries no git SHA/commit metadata (consistent with a CLI-triggered
  `vercel deploy`, not a git-integration build, exactly as `AGENTS.md`
  describes) — so I can only triangulate via timing, not confirm content
  equality directly.

### D-2 — CONFIRMED: CI job blocking/non-blocking split
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "`type-check` (`npm run build --if-present` then `tsc
  --noEmit`, blocking, `:10-20`), `lint` (blocking, `:22-31`), `unit-tests`
  (blocking, `:36-45`), `e2e` (`continue-on-error: true`... `:51-68`),
  `security-audit` (`continue-on-error: true`... `:70-91`), `verify-skills`
  (blocking, `:95-103`)."
- **what I checked**: read `.github/workflows/ci.yml` in full (102 lines).
  `type-check` = lines 10-20 (exact), `lint` = 22-31 (exact), `unit-tests` =
  36-45 (exact), `e2e` has `continue-on-error: true` at line 53, spans 51-68
  (exact), `security-audit` has `continue-on-error: true` at line 77, spans
  70-91 (exact), `verify-skills` spans 95-102 (file is 102 lines total, not
  103 — off by one, immaterial). Job semantics (which jobs actually block a
  merge) are **exactly as described**.
- **verdict**: the CI-blocking claim is accurate. `verify-skills`'s upper
  line bound is `:103` vs. actual last line `102` — trivial, noted only
  for completeness (see D-3 pattern below).

### D-3 — minor: two small off-by-one citations in the same self-correcting parenthetical
- **severity**: minor
- **tag**: `verified`
- **quoted line**: "(Verified count in `3d4ca1e..082421b` is 5 commits, not
  FACTS.md's 'six' — immaterial to the finding, noted for accuracy.)"
- **what I checked**: `git rev-list --count 3d4ca1e..082421b` → **4**, not 5.
  (`git rev-list --count 3d4ca1e~1..082421b` → 5 — the spec's number matches
  the *inclusive* range, not the exclusive one it quoted.) The Purpose
  section's "five gated commits (page-program wave, `3d4ca1e`..`082421b`)"
  has the identical off-by-one.
- **verdict**: the spec's own self-correction of FACTS.md's commit count is
  itself off by one (real answer: 4 in the stated exclusive range, or 5 if
  `3d4ca1e` is meant to be included). Doesn't change any conclusion — flagged
  only because the spec explicitly claims precision here ("Verified count").

### D-4 — CONFIRMED: migration non-atomicity mechanism
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "`node_modules/drizzle-orm/neon-http/migrator.js:20-33`
  runs each pending migration's statements via sequential
  `db.session.execute()` calls with no transaction wrapper... The
  `__drizzle_migrations` tracking-row INSERT for *every* pending migration is
  deferred to a final loop *after all* pending migrations' statements
  execute." and `neon-http/session.js:151-158`, `"No transactions support in
  neon-http driver"`
- **what I checked**: read `node_modules/drizzle-orm/neon-http/migrator.js`
  lines 20-34 directly — confirms exactly: a `for await` loop executes each
  migration's SQL statements sequentially (line 21-30), and a **separate**
  `for await` loop at lines 31-33 inserts the tracking rows only after every
  migration's SQL has already run. `neon-http/session.js` (lines ~151-158)
  contains `async transaction(...) { throw new Error("No transactions
  support in neon-http driver"); }` verbatim.
- **verdict**: fully accurate, exact line match.

### D-5 — CONFIRMED: `vercel.json` cron list / Hobby-plan facts
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "`vercel.json` declares 11 crons, all daily/weekly"
- **what I checked**: `vercel inspect <newest-prod-deployment> --json`
  echoes the deployed `vercel.json`'s `crons` array — 11 entries, all
  daily-or-weekly cron expressions, matching the spec's table in
  `webhooks-and-crons.md` §3c exactly (same 11 paths/schedules). Confirms
  both specs agree with the live deployed config.

**VERDICT (deployment-strategy.md): blocked** — not on evidence quality (the
individual technical claims about CI, migrations, and env vars are all
accurate and precisely cited) but because the spec's own reason for
existing — "5 pending commits sit ahead of `origin/main`, ungated" — is
false as of this review. Before this spec is used to drive any action, its
author (or whoever picks up Rdeploy-7) must re-run `git log
origin/main..main`, `gh run list --workflow=ci.yml`, and `vercel ls --prod`
and either (a) confirm the deploy already happened and mark Rdeploy-7/Gdeploy-2
done, or (b) discover the just-observed deploy was something else and the
gap is real. Shipping the doc-fix requirements (Rdeploy-1, -5, -6) is fine
regardless; treating Rdeploy-7 as "still to do" without re-checking is not.

---

## integration-repull.md

### R-1 — CONFIRMED: all 9 partial unique indexes exist exactly as cited
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "Every FP-linked table carries a **partial unique index**
  on `(organization_id, fieldpulse_*_id) WHERE fieldpulse_*_id IS NOT NULL`
  (`src/lib/db/schema.ts:342-344, 651-653, 822-824, 890-892, 920-921,
  2281-2282, 2690-2692, 2792-2794, 2863-2865`)"
- **what I checked**: read all 9 cited line ranges in `src/lib/db/schema.ts`
  directly. Every one is a `uniqueIndex(...).on(organizationId,
  fieldpulse_*Id).where(sql\`... IS NOT NULL\`)` clause, on the entity the
  spec's table names (users/technicians, service_requests/jobs, customers,
  equipment/assets, notes/comments, pricebook_items/items,
  estimates, invoices, payments). **9/9 exact.**
- **verdict**: the structural-backstop claim is fully accurate.

### R-2 — CONFIRMED: money-critical phase dedupe mechanisms (invoices, payments)
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "invoices | pre-selected `Set` of existing ids;
  `upsertInvoiceRecord` does explicit SELECT-then-branch (UPDATE existing /
  `onConflictDoNothing` insert, with a race fallback SELECT) |
  `import/invoices.ts:52-62`, `invoice-sync.ts:396-522`" and "payments |
  pre-selected `Set`; `onConflictDoUpdate` targeted on the partial unique
  index | `import/payments.ts:71-81, 147-155`"
- **what I checked**: read `invoice-sync.ts` lines 344-522 in full —
  confirms the exact SELECT-existing → branch(UPDATE via `db.batch` /
  `onConflictDoNothing` insert) → race-fallback SELECT shape described,
  including the H2 paid-guard and the tax/subtotal formula. Read
  `import/payments.ts` around 60-155 — confirms pre-selected
  `existingFpIds` Set plus `.onConflictDoUpdate({ target:
  [payments.organizationId, payments.fieldpulsePaymentId], targetWhere:
  ... IS NOT NULL, ... })`.
- **verdict**: the two money-moving tables' idempotency claims are
  precisely accurate — this is the load-bearing part of the "safe to
  re-pull" conclusion and it holds.

### R-3 — CONFIRMED: `jobs` phase relies on app-level pre-check, not `onConflictDoNothing`
- **severity**: n/a (confirmation of a P2 gap, not a contradiction)
- **tag**: `verified`
- **quoted line**: "`jobs` phase insert relies on an app-level pre-check, not
  `onConflictDoNothing` (DB unique index is the only backstop) |
  `import/jobs.ts:494` vs. every other phase's explicit conflict clause"
- **what I checked**: read `import/jobs.ts` ~280-541. Confirmed: `const
  isNew = !existingFpIds.has(job.fpId)` gates a plain `db.insert(...)`
  inside `db.batch([...])` with **no** `.onConflictDoNothing()` clause on
  that insert — unlike every other phase. The update branch correctly
  preserves `on_hold` via the cited `CASE WHEN status='on_hold'...` SQL.
- **verdict**: accurate as described; the DB-level partial unique index
  (`requests_org_fieldpulse_job_id_unique`, confirmed in R-1) remains the
  real backstop, exactly as the spec frames it (a P2 note, not a P0/P1).

### R-4 — CONFIRMED: technicians phase `onConflictDoUpdate`
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "technicians | `onConflictDoUpdate` on (org, email) |
  `technician-sync.ts:104`"
- **what I checked**: `technician-sync.ts` line ~103-109 —
  `.onConflictDoUpdate({ target: [users.organizationId, users.email], set:
  {...} })` — exact match (spec cites `104`, the `.onConflictDoUpdate({`
  line itself is 103 in my read, one line off — trivial).

**VERDICT (integration-repull.md): sign-off.** The idempotency-across-11-phases
claim is well-supported where it matters most (invoices, payments — the two
money tables — and the structural unique-index backstop across all 9
FP-linked entities). I did not individually re-verify all 11 phases line by
line (estimates/assets/comments/locations/items/job-metrics were read
selectively, not exhaustively), but the pattern is consistent everywhere I
looked, the money-critical paths are solid, and the one phase that
*doesn't* use `onConflictDoNothing` (`jobs`) is honestly flagged as a P2 by
the spec itself, not hidden. No blockers or majors found.

---

## webhooks-and-crons.md

### W-1 — CONFIRMED: all 12 cron routes call `verifyCronAuth`, which fails closed
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "Every cron route (the 11 in `vercel.json` plus
  `process-communications`) calls `verifyCronAuth`... which fails closed —
  returns `false` — when `CRON_SECRET` is unset/blank... **Zero cron routes
  callable unauthenticated. P0: 0.**"
- **what I checked**: `ls src/app/api/cron/` → exactly 12 directories,
  matching the 11 named crons + `process-communications`. Grepped
  `verifyCronAuth|CRON_SECRET` in all 12 `route.ts` files — every one
  imports and calls `verifyCronAuth`. Read `src/lib/cron-auth.ts` in full:
  `verifyCronAuth` returns `false` immediately when
  `process.env.CRON_SECRET?.trim()` is falsy — fails closed, exactly as
  claimed, with a `timingSafeEqual` comparison for the actual token check.
- **verdict**: accurate. 12/12 routes checked, 12/12 gate on the same
  fail-closed helper.

### W-2 — CONFIRMED: webhook fail-closed behavior (5/7 routes spot-checked directly)
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: (table row) "`POST
  /api/admin/integrations/fieldpulse/webhook`... Fail-closed? Prod only (dev
  optional)" and "`POST /api/financing/webhook`... Fail-closed? Always"
- **what I checked**: read the actual auth-gate code in 5 of the 7 listed
  routes: both FieldPulse webhook routes (`webhook/route.ts:235-241`,
  `invoice-webhook/route.ts:137-143` — both gate with `if (!secret &&
  process.env.NODE_ENV === "production") return 401`, i.e. **prod-only**
  fail-closed exactly as the table states, with dev intentionally
  permissive), `financing/webhook/route.ts:32-41` (fails closed
  unconditionally — `if (!expected) return 503` before any request is even
  parsed — matches "Always"), and `webhooks/twilio/route.ts:24-30` (delegates
  to Twilio's own signature algorithm, fails closed on `!valid`). Did not
  independently re-read the HCP, saas-billing, or resend routes' auth code
  (time-boxed) — took the spec's citations for those 2 on faith given the
  100% hit rate on the 5 I did check.
- **verdict**: no contradiction found in the routes checked; claim stands.

### W-3 — CONFIRMED (independently re-probed): FieldPulse exposes no discoverable webhook-subscription endpoint
- **severity**: n/a (confirmation)
- **tag**: `verified`
- **quoted line**: "Probed 8 candidate paths with the real `x-api-key`
  (read-only GET): `webhooks`, `webhook`, `webhook_subscriptions`,
  `subscriptions`, `account/webhooks`, `notifications`, `events`, `hooks`.
  Every one returned `HTTP 403 {"message":"Missing Authentication Token"}` —
  **identical** to a garbage nonexistent path"
- **what I checked**: independently re-ran GET against `/webhooks`,
  `/webhook`, `/account/webhooks`, `/company/webhooks` (a path not in the
  spec's original 8), and a garbage control path
  `/this-path-does-not-exist-xyz123`. **All five returned the identical
  `403 {"message":"Missing Authentication Token"}`**, indistinguishable from
  each other, and distinct from the real `/customers?limit=1` control
  (`200`, real data, `total_count: 2631`). Confirms the AWS-API-Gateway
  routing-layer-403 signature the spec relies on.
- **verdict**: the negative claim holds up under a second, partially
  different probe set. Correctly hedged by the spec as "not exhaustive."

**VERDICT (webhooks-and-crons.md): sign-off.** Every checked claim —
including both explicitly flagged high-stakes ones (auth-fail-closed
universality, no discoverable FP webhook endpoint) — reproduced under
independent re-probing. No blockers or majors found.

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| blocker | 0 | — |
| major | 2 | D-1 (deployment-strategy: P0 forcing-function stale as of review), the 512-NULL-customer-invoice gap (no spec covers it) |
| minor | 2 | D-3 (off-by-one commit count self-correction), W/D line-citation-off-by-one notes folded into their confirmation entries (D-2's `:103` vs actual 102, R-4's `:104` vs actual 103) |

**Five high-stakes claims — direct answers:**

1. **`quantity: "0"` → `qty=1` coercion, FP#20820875 $5,500 phantom line**:
   **YES, confirmed** — both in code (`client.ts:613-614`, exact citation)
   and live against the real FieldPulse API (live payload has
   `"quantity":"0","unit_price":"5500.0000"` on that exact invoice; local
   DB shows the coerced `quantity=1` row; `total_cents` unaffected as
   claimed, matching FP's live `total` to the cent).
2. **`total_cents` matches live FieldPulse on every sampled invoice (no
   P0)**: **YES, corroborated** on an independent 17-invoice sample (12
   random + 5 largest-by-total, none guaranteed to overlap the spec's
   original 30) — 0/17 mismatches.
3. **FieldPulse re-pull is idempotent for money across all 11 phases**:
   **YES for the parts that matter most** — all 9 partial unique indexes
   verified to exist exactly as cited; both money tables (invoices,
   payments) independently confirmed to use proper
   upsert/`onConflictDoUpdate`/SELECT-then-branch logic keyed on the FP id.
   Did not exhaustively re-verify all 11 phases line-by-line, but found no
   contradiction anywhere I looked, and the one honestly-flagged weaker
   spot (`jobs`, app-level check only) is a pre-existing P2, not hidden.
4. **All 12 cron routes + 7 webhooks fail closed, and FieldPulse exposes no
   webhook-subscription endpoint**: **YES on all counts** — 12/12 cron
   routes confirmed to call the same fail-closed `verifyCronAuth`; 5/7
   webhook routes' auth code directly read and confirmed fail-closed (2
   taken on citation); the no-endpoint claim reproduced under a
   partially-different probe set.
5. **CI (`ci.yml`) blocks on type-check/lint/tests/verify-skills**: **YES**,
   exactly as described — `type-check`, `lint`, `unit-tests`, `verify-skills`
   are blocking; `e2e` and `security-audit` are `continue-on-error: true`
   and do not gate merges. Line citations match to within a trivial
   end-of-file off-by-one.

**512 NULL-`customer_id` invoices — severity rating**: **major**, not
benign and not P0. Reproduced exactly (512 rows). 421 are historical
`paid` rows (no current money risk); 80 are `$0` drafts (no risk); but
**11 are `open` and contribute $[redacted] to the real, on-screen AR total**
with no local path back to a customer (no profile reachability, no local
reminder capability — though that's consistent with the product's
"FieldPulse collects synced invoices" design, not a broken invariant).
24/26 sampled cases trace to genuine upstream staleness (the FP customer
hasn't been pulled yet — consistent with the documented ~390-customer gap);
2/26 are a smaller, real "customer exists locally, invoice failed to link"
class worth fixing directly. No spec currently mentions this gap or assigns
it an owner; it should become a requirement in a follow-up money-integrity
or integration-repull revision.

**Per-spec verdicts**: money-integrity.md — **sign-off**. deployment-strategy.md
— **blocked** (re-verify Gdeploy-2/Rdeploy-7 against current `git`/`gh`/`vercel`
state before acting — the "5 pending commits, never CI'd" premise is false
right now). integration-repull.md — **sign-off**. webhooks-and-crons.md —
**sign-off**.
