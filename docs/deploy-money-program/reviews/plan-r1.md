# Round 1 — Adversarial review of PLAN.md

Reviewer stance: adversarial, evidence-only. Every claim below was re-derived
from the actual source file or a read-only DEV-branch probe, not taken on
PLAN's word. No writes: no `vercel` command, no importer run, no non-GET
external request, no DB write. Temp probe script
(`probe-plan-r1-verify-8f3d9c.mjs`, repo root) was deleted after use. All DB
probes ran against `ep-patient-surf-aqyjr5da-pooler...` (`current_database:
neondb`, confirmed DEV) — never `ep-withered-hill`.

---

## P-1 — M1's own framing contradicts the fix it's supposed to produce

- **plan item**: M1
- **severity**: `major`
- **tag**: `verified`
- **quoted line**: "FieldPulse sends `quantity: "0"` to mean "flat quoted
  price"." … "Preserve the flat-price meaning instead of fabricating a
  quantity."

**What actually happens.** Read `src/lib/integrations/fieldpulse/client.ts:613-614`
directly:

```ts
const parsedQty = Number.parseFloat(String(comp.quantity ?? "1"));
const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
```

Coercing `0 → 1` **already implements** "flat-price" semantics: `lineTotalCents
= qty(1) × unitPriceCents(550000) = $5,500` (`invoice-sync.ts:330-331`,
`lineTotalCents: Math.round(li.quantity * li.unitPriceCents)`). That IS the
current, buggy behavior — the one PLAN itself calls a "phantom $5,500 line."
So M1's own prose gives an implementer two contradictory instructions in the
same sentence: keep the "flat-price meaning" (→ line stays $5,500) vs. "don't
fabricate a quantity" (→ line becomes $0). Only one is correct.

I determined which is correct by checking the header math live: FP#20820875's
real `total`/`subtotal` = `$1,059.75`, which equals the OTHER two line
components summed ($750.00 + $309.75) with **zero contribution** from the
`quantity:"0"` line. The $5,500 "flat quoted price" is not billed at all —
it's not in FP's own total. So "flat quoted price" is a misleading label in
the evidence write-up; the correct behavior is a literal zero contribution,
exactly what `money-integrity.md`'s own Rmoney-3 acceptance criterion demands:
`sum(lineTotalCents) === invoice.subtotalCents`, which for this invoice
requires the first line's `lineTotalCents` to be **0**.

**Does the UI divide by quantity anywhere?** No. `invoice-document.tsx:145-152`
renders `li.quantity`, `li.unitPriceCents`, `li.lineTotalCents` as three
independent columns — no division, so a quantity=0 fix cannot divide-by-zero.

**Concrete fix.** In `toLineItems()` (`client.ts:613-614`), drop the `> 0`
floor for the MONEY-facing quantity so a real zero stays zero:

```ts
const parsedQty = Number.parseFloat(String(comp.quantity ?? "1"));
const qty = Number.isFinite(parsedQty) ? parsedQty : 1; // 0 stays 0; only a genuinely unparsable value falls back to 1
```

`lineItemRows()`'s display column already independently clamps
(`Math.max(1, Math.round(li.quantity))`) — leave that as-is; it's the
money computation (`costCents`/`lineTotalCents = qty × unit*Cents`) that must
see the real 0. **PLAN's framing ("preserve the flat-price meaning") is not
achievable as literally written** — there is no dollar amount to preserve
for these lines; the plan should say "coerce to a literal zero," not
"preserve the flat-price meaning."

---

## P-2 — M1's fix, correctly implemented, creates a new display inconsistency PLAN never names

- **plan item**: M1
- **severity**: `minor`
- **tag**: `verified`
- **quoted line**: "the invoice detail page's margin roll-up is wrong."

Once the money computation correctly zeroes the line, `invoice-document.tsx`
will render that row as **quantity `1`, unit price `$5,500.00`, amount
`$0.00`** (display quantity is independently clamped to `Math.max(1,
Math.round(0)) = 1`, while unit price is untouched). To anyone reading the
admin invoice document, "1 × $5,500.00 = $0.00" reads as a broken
calculation, not a fixed one. Scope check: `invoice-document.tsx` is admin-only
(no portal/customer-facing usage found), which limits blast radius, but the
plan's acceptance bar (margin figure correct) says nothing about this visible
side effect.

**Fix**: when `unitPriceCents > 0` but the money-quantity is a real zero,
either suppress the unit-price column for that row or add a short badge
("not billed") so the $0 doesn't read as an arithmetic error. Not required
for money correctness — flagged so it isn't a surprise during QA.

---

## P-3 — M3 does not satisfy Rmoney-2's acceptance criteria; it's a data patch mislabeled as the spec's fix

- **plan item**: M3
- **severity**: `major`
- **tag**: `verified`
- **quoted line**: "M3 | `Rmoney-2` | 3 invoices are `state='paid'` while
  still owing (~$630). They predate the guard that now prevents this and
  were never corrected. One-off reconcile, forward guard already shipped
  (B7)."

`money-integrity.md`'s Rmoney-2 requirement is explicit: "**Add a query/alert**
(dashboard banner, cron check, or audit-log entry) surfacing any invoice where
`state='paid' AND amount_paid_cents < total_cents`. Acceptance: a test
asserts the query returns 0 rows on a fixture where this state is impossible,
>0 on one that reproduces it; **wired into the invoice list or a monitoring
surface, not just documented**." That is a standing detection mechanism.
M3 delivers only a one-time SQL correction of the 3 currently-known rows plus
a pointer to the pre-existing FieldPulse-sync-time guard (`invoice-sync.ts:361-365`,
"B7"). That guard only fires when this exact invoice is re-synced from
FieldPulse — it is not a general invariant check, has no fixture test, and
is not wired into any admin surface. If this state is ever produced by a
different path (manual edit, a different integration, a future bug), nothing
detects it. Re-verified the target population directly (read-only DEV probe):

```
3 rows, state='paid', amount_paid_cents < total_cents:
  bc4773eb… fp#20807625  total 17500  paid 0      balance 17500
  1ffe599f… fp#20776752  total 40500  paid 0      balance 40500
  2cabc552… (native)     total 56592  paid 51592  balance 5000
```
Sum = $630.00 — exact match to PLAN's figure. Correct data, wrong deliverable.

**Fix**: either (a) rename M3's target requirement to something scoped to
"one-off reconcile," and add a *separate* item that actually builds Rmoney-2's
monitoring query with its fixture test, or (b) expand M3 to build the query
so the ID it claims is honestly earned.

---

## P-4 — M3/R1 interaction is unaddressed: 2 of the 3 rows will very likely self-heal on the next re-pull, making the manual fix redundant if sequenced after R1

- **plan item**: M3, R1
- **severity**: `minor`
- **tag**: `verified`

`upsertInvoiceRecord` (`invoice-sync.ts:344-370`) computes `state` and the
H2-guarded `amountPaidCents` unconditionally, before branching into
INSERT/UPDATE, and a re-sync replaces an existing invoice's money fields in
full (`invoice-sync.ts:414-448`, delete+insert of line items, update of the
money columns in the same `db.batch()`). Of M3's 3 rows, **2 are
FieldPulse-synced** (`fp#20807625`, `fp#20776752`); when R1 re-pulls them, if
FieldPulse's live payload still reports `state:"paid", amount_paid:0` (the
exact shape the H2 guard exists for), the guard will independently correct
`amountPaidCents` to `totalCents` — the same outcome the one-off SQL
produces. Only the 1 native row (`2cabc552…`, $50, `fieldpulse_invoice_id IS
NULL`) is untouched by any FP sync and strictly needs the manual fix. This
isn't unsafe (the manual patch, if applied first, isn't "re-broken" by R1 —
R1 recomputes to the same corrected value), just redundant and unsequenced.
PLAN doesn't note the overlap or order M3 relative to R1.

**Fix**: note in PLAN that M3's manual SQL is only strictly required for the
1 native row; the 2 synced rows are a belt-and-suspenders duplicate of what
R1 will do anyway, and running M3 before vs. after R1 is immaterial to
correctness (confirm via the H2 guard, not assumed).

---

## P-5 — R1: the *only* thing preventing the FieldPulse importer from targeting production is an operator reading a printed line during an interactive prompt

- **plan item**: R1
- **severity**: `blocker`
- **tag**: `verified`
- **quoted line**: "R1 | Run the FieldPulse re-pull **into the DEV branch
  only**. … Re-run is proven idempotent for money across all 11 phases…"

Read `src/lib/integrations/fieldpulse/import/run-import.ts` in full (473
lines). The DB target is resolved as:

```ts
dotenv.config({ path: ".env.local" });
...
const databaseUrl = process.env.DATABASE_URL;
...
const sql = neon(databaseUrl);
```

`dotenv.config()` does **not** override an already-set `process.env` variable
— if `DATABASE_URL` happens to already be exported in the invoking shell
(e.g. left over from a `vercel env pull`, a prod `.env` sourced for an
unrelated task, or a CI runner's ambient env), the importer silently targets
*that* database instead of `.env.local`'s, with `.env.local`'s value never
even read. There is **no hostname check anywhere in this file** — grepped for
`withered-hill`, `prod`, `production`: the only hits are a code comment
("the confirmation exists to prevent accidental prod writes") and the
generic word "production" inside that same comment. The runtime behavior is:
print the resolved DB host, print the org name, and require the operator to
type the literal string `import` at an interactive `readline` prompt
(`requireConfirmation`, ~line 210-224). That's it. No `if (dbHost.includes(...))
throw` exists. **`.env.local` is not a guard the code enforces — it's a
convention the operator must notice and trust**, verified by reading every
line of the file's DB-resolution and confirmation path.

This matters concretely, not hypothetically: `FACTS.md`'s own incident log
records that in *this same program*, an agent ran `vercel deploy --prod
--yes` despite an explicit "do not deploy" instruction in its brief — a
process failure, not a tooling one. `fp:import` is strictly more dangerous
to run against prod by accident than a deploy: it doesn't just serve new app
code, it **deletes and re-inserts real invoice/payment rows** in whatever
database `DATABASE_URL` resolves to (`invoice-sync.ts:414-448`). A repeat of
the exact same class of failure — an agent or operator running the command
in an environment where `DATABASE_URL` isn't what they assumed — would
silently corrupt production money data, not just redeploy known-good code.

**Answering the task's specific sub-questions directly:**
- *Blast radius if interrupted halfway*: low. Every phase is independently
  idempotent (partial unique indexes + pre-selected-Set/`onConflictDoUpdate`
  keyed on FP id, confirmed by reading `import/invoices.ts:52-99` and
  `import/payments.ts:60-155` myself — matches `integration-repull.md`'s R-2
  claim exactly). A killed process leaves already-processed rows correctly
  upserted and un-processed rows untouched; no partial-row corruption is
  possible. The one real gap is operational, not correctness: a killed run
  leaves its `fp_import_runs` row stuck at `status:'running'` forever (no
  SIGINT/SIGTERM handler) — this is exactly what O1/Rpull-3 is meant to fix,
  and O1 is correctly in committed scope, but **has not yet been built**
  (grepped `src/`: no `fp:reap-stale` script, no `isStaleRun` write path
  exists anywhere — it remains display-only). Running R1 before O1 ships
  means any interruption reproduces the exact 18-day-stuck-row failure mode
  FACTS.md already documented once.
- *Resume*: no incremental resume within a phase — every re-pull, interrupted
  or not, is a full re-page of that phase from page 1 (confirmed:
  `integration-repull.md` §2 — a `--since` filter was tried and reverted
  because FP ignores server-side date filters). Safe, just slow.
- *Does re-running rewrite the 4 native test invoices DEV retains?* No,
  verified directly: `import/invoices.ts:52-62` pre-selects existing rows
  `WHERE fieldpulse_invoice_id IS NOT NULL` and only ever upserts items
  pulled from FieldPulse's own `/invoices` list, each carrying a real FP id.
  Read-only DEV probe confirms exactly 4 invoices have `fieldpulse_invoice_id
  IS NULL` in the org today; none of the import code paths select or write to
  a NULL-`fieldpulseInvoiceId` row. Native rows are untouched by R1.

**Is R1 safe to run as described? No** — not because the idempotency proof is
wrong (it isn't; independently re-verified above), but because "into the DEV
branch only" is an unenforced assumption. **Concrete fix**: add a hostname
guard to `run-import.ts`'s `main()` before the confirmation prompt, e.g.:

```ts
const dbHost = parseDbHost(databaseUrl);
if (dbHost.includes("ep-withered-hill") && !process.argv.includes("--i-understand-this-is-prod")) {
  console.error(`ERROR: DATABASE_URL resolves to a host that looks like production (${dbHost}). Refusing to run.`);
  process.exit(1);
}
```
This is the same class of fail-closed check the cron/webhook routes already
use (`cron-auth.ts` fails closed on missing config) — the importer should
fail closed on a suspicious host, not rely on a human reading console output.

---

## P-6 — S1, S2, and O2 are presented as future work but were already shipped in the exact commit that introduces PLAN.md itself

- **plan item**: S1, S2, O2
- **severity**: `major`
- **tag**: `verified`
- **quoted line**: "S1 … Add a daily Vercel-native backstop." / "S2 …
  Add it to the existing 5-minute Actions pinger — reusing the pattern
  already in the repo, not inventing one." / "O2 … Correct them, and link
  `DEPLOY-RUNBOOK.md`."

`git log --oneline -5` shows current `HEAD` is `320db94`, titled `fix(deploy):
close cron coverage gaps and correct dangerously stale migration docs`. Its
own commit body states, verbatim: "S1: … Added a daily Vercel-native
backstop (12 crons now, all Hobby-legal)." / "S2: … Added to the existing
5-minute pinger…" / "O2: … Corrected [MIGRATIONS.md/DEPLOYMENT.md]…" — and
`git show 320db94 --stat` shows **that same commit also adds
`docs/deploy-money-program/PLAN.md`, `FACTS.md`, and
`reviews/specs-r1-evidence.md`**. Independently confirmed live:
`vercel.json` has 12 crons today with `process-communications` present
(line 13); `.github/workflows/sub-daily-crons.yml` has three ping steps
today, including a `reconcile-payments` step with a comment matching PLAN's
own S2 rationale nearly word-for-word; `docs/DEPLOYMENT.md`'s migration
section already reads "Migrations run automatically during the build."

So PLAN.md's "Committed scope" table uses forward-looking, imperative
language ("Add", "Extend", "Correct") for three items that are, as of the
commit introducing the document, **already merged to `main`** — not proposed,
not pending review, done. Nothing in PLAN.md marks them `DONE` or
distinguishes them from M1/M2/O1/R1, which genuinely are still open. A
reader using this table as a punch-list (which is its evident purpose) has
no way to tell "go build this" from "already shipped, nothing to do" without
independently digging through `git log` — exactly the kind of staleness the
program's own `specs-r1-evidence.md` (D-1) already flagged once for a
different section of this same effort ("the spec's own reason for existing
… is false as of this review").

**Fix**: mark S1/S2/O2 `✅ shipped in 320db94` in the table (or move them out
of "Committed scope" into a "Done this session" section), so the plan
doesn't misrepresent current repo state to whoever reads it next.

---

## P-7 — Seven P0/P1 spec requirements are dropped: absent from both "Committed scope" and "Not being built"

- **plan item**: (scope gaps across all four specs)
- **severity**: `major`
- **tag**: `verified`
- **quoted line**: PLAN.md's "Committed scope" tables (M1-M3, S1-S2, O1-O2,
  R1) and "Not being built" list (HCP re-pull, FP webhook subscription, FP
  webhook secret, new scheduler, Vercel Pro upgrade, Money P2s) — neither
  section contains the IDs below.

| Req ID | Spec | Priority | What it requires | Verified absent from repo today |
|---|---|---|---|---|
| **Rmoney-1** | money-integrity.md | P1 | A recurring (e.g. weekly) live-FieldPulse-vs-local reconciliation script/report, `npm run`-able | No such script in `scripts/` or `package.json` |
| **Rmoney-4** | money-integrity.md | P1 | A note in FACTS.md (or successor) stating DEV money figures are a point-in-time snapshot (2026-07-08) not to be quoted as current | FACTS.md documents customer-count staleness generically but has no such invoice-specific caveat |
| **Rpull-2** | integration-repull.md | P1 | Confirm (not infer) which Neon branch `fp-nightly-sync.yml`'s `DATABASE_URL` secret actually points at | Not mentioned; PLAN's own R1 line still says "Production is already swept nightly," resting on the same inference the spec flagged as unconfirmed |
| **Rdeploy-2** | deployment-strategy.md | P0-tied (Gdeploy-3) | A CI-wired grep script flagging non-idempotent migration SQL (bare `DROP`/`ADD COLUMN` without `IF NOT EXISTS`) | `grep -rn "idempotent" .github/workflows/ci.yml scripts/agent/` → nothing; no such script exists |
| **Rdeploy-3** | deployment-strategy.md | P0-tied (Gdeploy-3) | Runbook step: dry-run `db:migrate` against DEV before any prod deploy carrying a migration | Read `DEPLOY-RUNBOOK.md`'s "The sequence" (6 steps) end to end — no DEV migration dry-run step exists |
| **Rdeploy-4** | deployment-strategy.md | P1 | `prod-smoke.sh` asserts `/api/health` 200 + authenticated GET 200 on invoices/dispatch/estimates | `grep "api/health\|invoices\|dispatch\|estimates" scripts/agent/prod-smoke.sh` → no matches; script only checks `/`, `/chat`, `/admin/login` |
| **Rdeploy-5** | deployment-strategy.md | P1 | `DEPLOYMENT.md`'s required-vars block corrected to match `REQUIRED_ENV_VARS` (drop `ANTHROPIC_API_KEY`, add `AUTH_SECRET`/`ENCRYPTION_KEY`/`CRON_SECRET`) | `grep -n ANTHROPIC_API_KEY docs/DEPLOYMENT.md` → still present at lines 27, 175, 272, 285, 498, today, post-O2 |

Two of these (Rdeploy-2, Rdeploy-3) are tied directly to `Gdeploy-3`, the
spec's own P0 finding about non-atomic, never-dry-run migrations — the
single scariest fact in the whole program (a failed migration N+1 after a
successful migration N leaves the DB with untracked-but-applied DDL). O2
fixes the *documentation* half of that story (Rdeploy-1) but not the
*mechanism* half (Rdeploy-2/3). Rdeploy-5 is explicitly named as safe-to-ship
in the program's own round-1 evidence audit ("Shipping the doc-fix
requirements (Rdeploy-1, -5, -6) is fine regardless" —
`reviews/specs-r1-evidence.md` line ~280) yet PLAN's O2 only shipped
Rdeploy-1; Rdeploy-5 was left behind without comment.

**Fix**: either fold Rdeploy-2/3/5 and Rmoney-1/4 and Rpull-2 into a
follow-up committed-scope table, or add them to "Not being built" with a
stated reason (cost/risk tradeoff, blocked-on-fact, etc.) — silence is the
one option the task's own instruction ("no P0/P1 dropped without a reason")
rules out.

---

## P-8 — Testability: several committed/adjacent items can only be proven by deploying or running the importer — PLAN's Gates section doesn't say so

- **plan item**: Gates (all), R1, S1/S2 (already shipped, see P-6)
- **severity**: `minor`
- **tag**: `verified`

AGENTS.md's testing rule is explicit: no jsdom/RTL, pure-helper vitest only.
Under that constraint:

- **R1's acceptance is fundamentally not a unit-test question.** Its claim
  ("safe to re-pull") is proven by static/code-reading analysis (done, here
  and in the specs) plus, ultimately, only by actually running `npm run
  fp:import` against real data — which this task, the specs, and this review
  are all explicitly forbidden from doing. `npx vitest run` passing says
  nothing about whether the live re-pull behaves as documented.
- **S2's own spec acceptance criterion is deploy-only**: `webhooks-and-crons.md`
  §8 states "Rsync-2: `vercel deploy --prod --yes` must succeed with the new
  entry in `vercel.json` — a non-daily schedule fails at deploy time, so a
  successful deploy IS the legality proof." Per P-6, `vercel.json` already
  has the 12th cron on `main` — but whether it has ever actually been proven
  to deploy successfully on Hobby (as opposed to merely being syntactically
  present) is **unverifiable from this read-only review**, since checking
  requires either a live `vercel` inspection of a deployment built from
  `320db94`'s tree, or a new deploy — both out of bounds here.
- **Rdeploy-4** (not built, see P-7) would, if built, only be exercisable by
  running `prod-smoke.sh` against a live production URL — inherently
  deploy-dependent, not something `npx vitest run` can gate.
- **M1's own spec (Rmoney-3) overstates its test coverage.** It claims
  "existing fractional-quantity tests (7.5, 4.13) keep passing." Grepped the
  entire `fieldpulse` test suite (`client.test.ts`, 1,380 lines) for `7.5`,
  `4.13`, `toLineItems`, `lineItems` — **zero matches**. `toLineItems` and
  `toInvoice` are both unexported, module-private functions with **no
  existing test coverage at all** today. This is buildable (the file's
  existing pattern tests private mapping logic indirectly through the
  public `RestFieldpulseClient` methods with mocked `fetch`, e.g.
  `describe("RestFieldpulseClient — getCustomer", ...)`), so Rmoney-3's fix
  IS unit-testable without a DB/network — but the specific tests the spec
  says already exist do not, and PLAN inherits that claim uncritically.

**Fix**: PLAN's Gates section should say plainly which acceptance criteria
are proven by `npx vitest run` (M1/Rmoney-3's fix, M2's UI logic if extracted
to pure functions) vs. which are only provable by a live deploy or a real
importer run (R1, S2's cron-legality claim, Rdeploy-4 if built) — and should
correct Rmoney-3's "existing tests" claim before an implementer goes looking
for tests that don't exist.

---

## P-9 — M2 is committed without an implementation target, unlike M1/M3

- **plan item**: M2
- **severity**: `minor`
- **tag**: `verified`
- **quoted line**: "Make them visible and countable so the operator can tell
  collectible AR from stranded AR. Do NOT silently exclude them from AR."

Independently reproduced the underlying figure (read-only DEV probe):
`state='open' AND amount_paid_cents < total_cents AND customer_id IS NULL`
→ **11 rows, [redacted cents figure]** — matches PLAN to the
cent. And the policy call is right: excluding these from AR would produce a
*more wrong* number, since FieldPulse's own live data confirms this $[redacted]
is real, currently-uncollected money (`specs-r1-evidence.md`'s independent
NULL-customer audit reached the same conclusion). No objection to the
decision. But unlike M1 (`client.ts:613-614`) and M3 (exact row ids), M2
names no file, no component, no query, and no acceptance test — it's a
product requirement, not yet a change spec. That's expected for a
same-session "new (evidence review)" finding, but it means M2 is the least
implementation-ready item in "Committed scope" despite being listed
alongside two items with line-precise fixes.

**Fix**: at minimum name the surface (e.g., a filter/badge on
`/admin/invoices` keyed on `customer_id IS NULL AND state='open'`) and an
acceptance check (a fixture with a NULL-customer open invoice must render
distinctly from a normal one) before this is handed to an implementer.

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| blocker | 1 | P-5 (R1 has no code-level guard against targeting production) |
| major | 5 | P-1 (M1 framing self-contradicts), P-3 (M3 doesn't satisfy Rmoney-2's acceptance), P-6 (S1/S2/O2 already shipped, framed as TODO), P-7 (7 dropped P0/P1 requirements) |
| minor | 4 | P-2 (M1 display side effect), P-4 (M3/R1 redundancy unaddressed), P-8 (testability gaps + Rmoney-3's phantom "existing tests" claim), P-9 (M2 under-specified) |

*(P-7 groups seven individually-named dropped requirement IDs under one
finding; counted once above.)*

**Correct M1 fix, stated plainly**: in `toLineItems()`
(`client.ts:613-614`), stop flooring a real `0` quantity to `1`. Change
`Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1` to
`Number.isFinite(parsedQty) ? parsedQty : 1` so `costCents`/`lineTotalCents`
compute to a literal `$0` for these lines (matching FieldPulse's own header
total, verified live), while the display `quantity` column
(`Math.max(1, Math.round(...))`) is left untouched. PLAN's "preserve the
flat-price meaning" framing is not the right instruction — there is no
dollar figure to preserve; say "treat as a real zero" instead.

**Is R1 safe to run as described? No.** The idempotency proof holds up
(independently re-verified: partial unique indexes, upsert paths, native-row
isolation, phase-level fault tolerance all confirmed by reading the code
directly) — but "into the DEV branch only" is an assumption enforced by
nothing except an operator reading a printed console line during an
interactive prompt. Given this program's own documented incident of an
agent violating an explicit "don't do X" instruction, and given this
specific command can overwrite live money data (not just redeploy code),
add the hostname guard in P-5 before anyone runs `fp:import` for real.

**Dropped requirement IDs** (P0/P1, absent from both committed scope and
"Not being built"): **Rmoney-1, Rmoney-4, Rpull-2, Rdeploy-2, Rdeploy-3,
Rdeploy-4, Rdeploy-5**.

**Verdict**: **not ready to act on as written.** The money-correctness
diagnosis throughout the program is careful and, where re-checked here,
accurate to the cent. But PLAN.md itself has one blocker (R1's unenforced
DEV-only assumption) and enough major gaps — a mislabeled fix (M1), a
requirement claimed-but-not-delivered (M3/Rmoney-2), silently-already-done
work presented as a to-do list (S1/S2/O2), and seven quietly dropped
P0/P1 items — that a reader acting on this document today would either
redo finished work, skip real gaps, or (worst case) run the importer with
no protection against a repeat of the program's own already-documented
unauthorized-production incident.
