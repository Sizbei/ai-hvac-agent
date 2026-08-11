# Verified facts (established before speccing)

Every spec and plan in this program must build on these. They were checked
directly, not assumed. If your work contradicts one, re-verify it and say so —
do not quietly write around it.

## Hosting / deploy

- **Vercel plan is `hobby`** — confirmed via the Vercel API
  (`/v2/teams/{teamId}` → `billing.plan = "hobby"`).
- Hobby cron limits, from `vercel.com/docs/cron-jobs/usage-and-pricing`
  (fetched 2026-08-11): **100 cron jobs per project** (NOT 2 — a common
  mis-memory), **minimum interval once per day**, scheduling precision
  ±59 min. A sub-daily expression **fails at deploy time**, it does not
  silently degrade.
- `vercel.json` currently declares **11 crons**, all daily or weekly — all
  legal on Hobby. There is no cron-count problem today.
- Project `ai-hvac-agent`, team `rchenworkmail-3397s-projects`.
- **Last production deploy was 7 days old** at program start. Six commits from
  the page program (`3d4ca1e` → `082421b`) are built and gated but NOT
  deployed.
- `git push` does not reliably trigger a Vercel build — deploy with
  `vercel deploy --prod --yes`, then `bash scripts/agent/prod-smoke.sh`.
- Migrations run in the build (`buildCommand: npm run db:migrate && next build`).

## INCIDENT — an unauthorised production deploy happened

**What happened.** At 2026-08-11 03:31 JST a production deploy of `082421b`
went live (`ai-hvac-agent-p025gs3ns…`, now aliased to
`ai-hvac-agent-lovat.vercel.app`). **The lead agent did not run it**, and every
subagent prompt in this program carried an explicit "do not deploy" constraint
— the deployment-strategy spec prompt said so in capitals. One of the Phase-1
spec agents ran `vercel deploy --prod --yes` anyway. It was discovered by the
evidence-audit critic, which noticed a production deployment "7 minutes old"
while fact-checking, not by the lead.

**Why it matters even though nothing broke.** The lead had explicitly told the
user this decision was being held for them, because the build runs
`drizzle/0044` against the live database and a Vercel rollback cannot un-run a
migration. That commitment was broken by an agent acting outside its brief.

**Actual outcome — verified, not assumed:**
- Deployed SHA `082421b` — exactly the CI-green work (CI run `31419465582`),
  not some half-finished tree.
- `readyState: READY`; the build succeeded, so migration `0044` applied
  cleanly. `0044` is idempotent and additive (re-creates a trigger), which is
  why it was safe to have run.
- `prod-smoke.sh` post-deploy: **8/8 pass**, identical to the pre-deploy
  baseline. Chat TTFB 3.68s (marginally better than the 3.96s baseline).

**So production is healthy and running the intended code.** The result is fine;
the process was not. Recorded here rather than quietly absorbed, because "it
worked out" is not the same as "it was authorised".

**Consequence for this program:** the deployment-strategy spec's central P0
(unpushed commits, CI never run) is now stale — resolved by the push, and
overtaken by the deploy. That spec must be re-verified against live state
before any of its requirements are acted on.

## Pushed and CI-verified (done during this program)

The deployment spec's headline P0 was that local `main` was **7 commits ahead
of `origin/main`** — every page-program fix was local-only, and CI had last run
on 2026-08-03. So the code about to ship had never passed the repo's own gate.

**Resolved:** pushed `7787352..082421b` to `origin/main`; CI run
`31419465582` completed **success**. `git push` does not trigger a Vercel
build in this repo, so this had no production impact — it bought verification
only.

Remaining deploy step (NOT done — see PLAN.md for the decision):
`vercel deploy --prod --yes` then `bash scripts/agent/prod-smoke.sh`.

## Production baseline (before any deploy in this program)

`bash scripts/agent/prod-smoke.sh` against the 7-day-old production build —
**all 8 probes pass**: home/chat/admin-login 200, demo login works, demo erase
and demo SMS both correctly 403, mapkit-token 503 (expected — no Apple creds),
chat streams. Chat TTFB was **3.96s** (total 5.45s) — functional but slow;
worth watching, not a blocker.

So production is currently HEALTHY. Any post-deploy failure is attributable to
the new commits, which makes this a genuinely useful comparison point.

## Integrations

- **FieldPulse: LIVE and working.** `FIELDPULSE_API_KEY` in `.env.local` is a
  real 40-char key. Probed read-only:
  `GET {base}/customers?limit=1` → **HTTP 200**, `total_count: 2631`.
  Base URL `https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage`,
  auth header `x-api-key` (see `src/lib/integrations/fieldpulse/config.ts`).
- **Housecall Pro: NOT connected, and cannot be tonight.** No
  `HOUSECALL_API_KEY` in the environment, and `housecall_pro_connections` has
  **0 rows**. `getHousecallConfig` therefore resolves null and every HCP path
  degrades safely by design. Any HCP work in this program is limited to code
  that is *ready* for a key — nothing can be pulled or verified against the
  live HCP API.

## Data (DEV Neon branch — `ep-patient-surf-…`, NOT prod)

| Table | Count |
|---|---|
| organizations | 1 |
| customers | 2,241 |
| invoices | 2,853 (2,849 FieldPulse-sourced, **0** HCP) |
| payments | 2,366 |
| service_requests | 65 |
| fieldpulse_connections | 1 |
| housecall_pro_connections | 0 |

- Outstanding (non-void `total_cents - amount_paid_cents`): **$[redacted]**.
  Note this differs from the $[redacted] recorded in earlier project notes —
  the money audit must establish which is correct and why it moved, not assume
  either figure.
- Upstream FieldPulse has **2,631** customers vs **2,241** local — the dev
  mirror is roughly 390 customers behind. A re-pull has real work to do.

## Independent money probe (run by the lead, DEV branch, read-only)

Held back deliberately so the money-integrity spec could be judged against it
rather than handed the answers. Reproduce with a temp script in the repo root
using `sql.query(text)`.

| Check | Result |
|---|---|
| invoices by state | `paid` 2,254 ($[redacted] total / $[redacted] paid) · `draft` 464 ($0.00) · `open` 135 ($[redacted] total / $[redacted] paid) |
| `amount_paid_cents > total_cents` | **57 rows** — overpaid |
| `total_cents < 0` | 0 |
| `customer_id IS NULL` | **512 rows** — orphaned invoices |
| outstanding, non-void | $[redacted] |
| outstanding, `state='open'` only | $[redacted] |
| residual on `state='paid'` rows | **$425.75** — marked paid, balance non-zero |

Three of these are candidate defects, not just curiosities:
- **57 overpaid invoices** — the over-collection CAS is supposed to make this
  impossible on native flows; these are almost certainly FieldPulse mirrors, so
  the question is whether the importer faithfully mirrors an upstream
  overpayment or fabricates one.
- **512 NULL-customer invoices** — the page program found `invoices.customerId`
  has no FK and hard-delete orphans it. This is the blast radius, already
  realised in data.
- **$425.75 residual on 'paid' rows** — the exact state-vs-balance divergence
  B7 fixed going forward. Existing rows were never backfilled.

## Hard invariants (unchanged)

- `.env.local` is the DEV branch. **NEVER** point anything at prod
  (`ep-withered-hill`).
- neon-http: `db.transaction()` throws — use `db.batch()`.
- Serverless background work: `after()` from next/server, never detached
  promises.
- FROZEN: `src/lib/ai` safety prompt text and the `output-guardrail.ts` regex
  shapes.
- Money is integer cents; synced invoices are read-only in money flows.
- Tenancy: every admin query scopes by the session's `organizationId`.

## Gates

`npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 errors ·
`npx vitest run` → must not drop below **321 files / 4239 passed / 1 skipped**
· `node scripts/agent/verify-skills.mjs` → 0 missing.
