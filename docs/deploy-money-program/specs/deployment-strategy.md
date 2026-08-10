# Deployment strategy — spec

One-org HVAC contractor SaaS on Vercel Hobby + Neon. "As deployable as
possible" means cheap, automatable confidence before a deploy; a migration
story that can't strand the database; a smoke test that covers what shipped;
and a written rollback procedure — not a pipeline nobody will run for a
single-tenant Hobby project.

## 1. Purpose

Close the real gaps between what this repo believes about its own deploy
process (`docs/DEPLOYMENT.md`, `MIGRATIONS.md`) and what actually happens
(`vercel.json`, `.github/workflows/`, the Drizzle neon-http migrator).
Immediate forcing function: five gated commits (page-program wave,
`3d4ca1e`..`082421b`) sit on local `main`, ahead of `origin/main` and the
live prod deploy, and need to go out safely.

## 2. Brainstorm

- **Staging environment** (separate Vercel project + Neon branch) —
  rejected. Vercel Previews already give every branch a free ad hoc
  staging URL; the DEV Neon branch already plays this role for migrations
  (Rdeploy-3). A formal staging tier doubles Neon compute for one org.
- **Blue-green / canary deploys, Kubernetes** — rejected outright per the
  brief. Vercel's build-then-atomically-promote-or-fail model already gives
  an all-or-nothing cutover; this project has no capacity to run or watch
  traffic-splitting infra, and it isn't containerized.
- **Swap CI/CD platforms** — rejected. GitHub Actions already does the job
  (`ci.yml`, `migrate.yml`, `fp-nightly-sync.yml`, `sub-daily-crons.yml`,
  `keep-warm.yml`, all verified working).
- **Rewrite the migration runner for real DB transactions** (swap
  `neon-http` for a driver where `db.transaction()` works) — rejected.
  Bigger, riskier change than the failure mode warrants; the repo already
  leans on idempotent migrations as its safety net (3b) — cheaper fix.
- **Redis-backed rate limiting now** — out of scope. Already tracked in
  `docs/DEPLOYMENT.md` as a future item with no current evidence of need.
- **Bot that auto-triggers Instant Rollback on an error threshold** —
  rejected. No alert-to-action pipeline exists to trigger it on, and a
  single operator clicking rollback is simpler than automating it.
- **New CI job running the full `db:migrate && next build` against a live
  DB on every PR** — rejected as disproportionate (new long-lived DB
  secret in Actions, one migration author). The proportionate version is a
  documented manual DEV-branch dry run (Rdeploy-3).
- **Secrets vault (Doppler/Vault)** — rejected. Vercel's encrypted env vars
  are the only secret store in play; no new sharing need at team-of-one.
- **Lightweight CI grep for non-idempotent migration SQL** — kept, folded
  into Rdeploy-2: a small script in the spirit of the existing
  `verify-skills.mjs`, not a platform.

## 3. Current state

**3a. Confidence before deploy.** `ci.yml` runs on push/PR to `main`:
`type-check` (`npm run build --if-present` then `tsc --noEmit`, blocking,
`:10-20`), `lint` (blocking, `:22-31`), `unit-tests` (blocking, `:36-45`),
`e2e` (`continue-on-error: true` — no DB-backed env provisioned, `:51-68`),
`security-audit` (`continue-on-error: true` — `npm audit` hard-fails today on
known, deliberately-deferred CVEs with breaking-only fixes, `:70-91`),
`verify-skills` (blocking, `:95-103`). Real, blocking CI exists on the parts
that matter. **But it never saw the code about to ship**: `git log
origin/main..main` shows local `main` is 7 commits ahead of `origin/main`
(`96a094a`..`082421b`, the full page-program wave); `gh run list
--workflow=ci.yml` confirms the last CI run was `7787352` (2026-08-03) —
none of the 7 newer SHAs ever triggered a run. (Verified count in
`3d4ca1e..082421b` is 5 commits, not FACTS.md's "six" — immaterial to the
finding, noted for accuracy.) "Gated" so far means local gate runs only.

**3b. The migration story.** `vercel.json:2` —
`"buildCommand": "npm run db:migrate && next build"`, confirmed by
`AGENTS.md:19-23` and `FACTS.md:24`. This **contradicts two docs**:
`MIGRATIONS.md:6-16` ("Vercel's build does not run migrations... applied
manually, on demand") and `docs/DEPLOYMENT.md:196-206` ("Vercel builds do
NOT run migrations. You must run migrations manually after deploying").
`vercel.json` is ground truth; both docs are stale — following either would
mean double-running migrations or wrongly believing a manual trigger is
still needed. `src/lib/db/migrate.ts` skips non-production `VERCEL_ENV`
(`:15-21`, protects the shared prod `DATABASE_URL` from preview builds),
fails fast on missing `DATABASE_URL` (`:23-25`), and on failure just logs +
`exit(1)` (`:37-40`) — no rollback attempt.
**Not atomic.** `node_modules/drizzle-orm/neon-http/migrator.js:20-33` runs
each pending migration's statements via sequential `db.session.execute()`
calls with no transaction wrapper (the generic pg-core dialect uses
`session.transaction()`, `pg-core/dialect.js:58-73` — a call that itself
throws under neon-http, `neon-http/session.js:151-158`,
`"No transactions support in neon-http driver"`). The
`__drizzle_migrations` tracking-row INSERT for *every* pending migration is
deferred to a final loop *after all* pending migrations' statements
execute. If migration N succeeds and N+1 fails, N's DDL is live but
untracked — the next run reapplies N's SQL from scratch, which fails again
unless every statement is idempotent. `vercel.json`'s `&&` means a failed
`db:migrate` blocks `next build`, so Vercel doesn't promote (old app code
keeps serving — inferred standard behavior, not independently re-verified)
— but the **database** can be left partially migrated and stuck.
Mitigating: the repo already leans idempotent by convention — no
`DROP COLUMN`/`RENAME`/`SET NOT NULL` found across any `drizzle/*.sql`
(grepped), and `0044_last_admin_guard.sql:17-22` explicitly documents
`CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS` "so the Vercel build's
auto-migrate does not fail against an already-guarded database" — awareness
that exists as one comment, not an enforced rule. **Never dry-run before
prod**: `migrate.yml` is manual/`workflow_dispatch`-only and documented via
the now-stale `MIGRATIONS.md`; no step exercises a *new* migration against
any database before it's attempted, for the first time, live, inside
`vercel deploy --prod --yes`. Migrations `0041`–`0044` (the pending
commits) very likely already ran once against the DEV branch during
development (inferred, not directly confirmed for these 4 files), never
against prod. **Forward-compatibility**: because migrate runs before build
and old code serves traffic until promotion, old code briefly runs against
new schema on every deploy — survivable in practice (additive/idempotent
convention) but not enforced as a rule.

**3c. Environment parity.** `instrumentation.ts:15-17` calls
`validateEnvVars()` on every cold start — a real boot-time gate.
`REQUIRED_ENV_VARS` (`env-validation.ts:23-148`) hard-requires exactly 5:
`DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`,
`NEXT_PUBLIC_APP_URL`, plus format checks (64-hex `ENCRYPTION_KEY`, ≥32-char
`AUTH_SECRET`, `:173-182`). 13 more are tracked as explicitly optional
(R2, `AI_API_KEY`, Google OAuth, Twilio, ElevenLabs, `RESEND_WEBHOOK_SECRET`)
with reasoning in comments — e.g. `:66-69`: the old required
`ANTHROPIC_API_KEY` "was a phantom — read nowhere — and made every clean
deploy crash at cold start," a bug this file already fixed once. `grep
process.env.` across `src scripts` finds **~65** distinct vars actually
read; only **18** are in the validated list. The other ~47
(`FIELDPULSE_API_KEY`, `HOUSECALL_API_KEY`, `STRIPE_SECRET_KEY`,
`WISETACK_API_KEY`, `QBO_CLIENT_ID/SECRET`, `RESEND_API_KEY`, Apple MapKit,
routing/geocoding keys, webhook secrets) sample as degrade-safe by design —
`integrations-status.ts:201-208` reports `live`/`not_configured` per
integration; `job-queue.ts:97` refuses to *claim* an email job when
`RESEND_API_KEY` is absent rather than claim-then-fail — but this isn't
exhaustively re-verified per var. `.env.local` sets 21 of the ~65; Vercel's
actual production env set could not be checked (`vercel env` excluded from
this read-only pass) — parity with prod is **inferred, not verified**.
`docs/DEPLOYMENT.md:20-39`'s required-vars block is wrong: lists
`ANTHROPIC_API_KEY` (real var is optional `AI_API_KEY`) and omits
`AUTH_SECRET`/`ENCRYPTION_KEY`/`CRON_SECRET` — the three secrets that
actually gate cold start.

**3d. Post-deploy verification.** `prod-smoke.sh` checks `/`, `/chat`,
`/admin/login` (200), demo login, demo erase/SMS blocked (403), mapkit-token
(503/200), and a chat-streaming TTFB gap (`:13-48`) — targeted, real checks.
**Gap**: `/api/health` — a purpose-built DB-connectivity probe
(`select 1`, 200/503) already wired into `keep-warm.yml` — is never called
by `prod-smoke.sh`. Nor is any of the ~30 admin pages beyond the login shell
touched — no invoices, dispatch, estimates, or accounting, i.e. none of the
surfaces the pending 5-commit wave changed. A deploy that broke the invoices
list today would smoke all-green.

**3e. Rollback.** Per Vercel docs (`vercel.com/docs/instant-rollback`,
fetched this session): Hobby Instant Rollback targets only the
**immediately previous** production deployment (Pro/Enterprise can target
any eligible past one). It repoints traffic to an already-built immutable
deployment — **does not** re-run the build, so **does not** re-run
`db:migrate`. It does **not** revert env vars ("Vercel won't update
environment variables... will roll back to a previous build"). After a
rollback, auto-promotion of new pushes is disabled until an operator
explicitly undoes it. **The asymmetry**: rollback is app-code-only. Since
migrations are forward-only (`MIGRATIONS.md:43`), a bad deploy's already-run
migration can't be undone by rolling the app back — old code then runs
against new schema. Given the additive/idempotent migration convention
(3b) that's usually survivable, but nothing says so and `MIGRATIONS.md`
never mentions rollback.

**3f. The 7-day gap.** Last prod deploy is 7 days old. The 5 pending
commits were never pushed (3a), so never CI'd. `git push` doesn't reliably
trigger a Vercel build anyway (`AGENTS.md:21-22`) — deploy is always the
explicit `vercel deploy --prod --yes` + `prod-smoke.sh`. Safe sequence: get
real CI signal on this exact code, dry-run the pending migrations against
DEV, deploy, then verify with an adequately-scoped smoke pack (Rdeploy-7).

**3g. Hobby-plan realities.** Hobby: 100 crons/project, daily-minimum
interval, ±59min imprecision; sub-daily expressions fail at deploy time
(FACTS.md, sourced from Vercel docs fetched 2026-08-11). `vercel.json`
declares 11 crons, all daily/weekly — legal today. **Already solved, not a
gap**: `sub-daily-crons.yml` pings `process-communications` (not in
`vercel.json` at all — GitHub Actions is its *only* trigger) and
`delay-sweep` every 5 minutes via the same fail-closed `CRON_SECRET` bearer
the routes already verify (`cron-auth.ts`, `cron-auth.test.ts:33-44`).
`fp-nightly-sync.yml` runs the ~20-minute FieldPulse full sweep from Actions
specifically because Vercel functions cap at 5 minutes even on Pro
(`:1-6`) — upgrading wouldn't fix that either. Repo is public (`gh repo
view` → not private), so Actions minutes are unmetered. **What Hobby
genuinely can't do**: Vercel-native crons finer than daily, or ±59min-precise
ones. Webhooks (Stripe/FieldPulse/HCP) and the chat API are unaffected —
not crons. Today's daily crons (dunning, reconcile-payments, FP invoice
sync) are fine at daily cadence; nothing observed needs sub-daily
reconciliation. **What Pro buys**: sub-daily-or-precise native crons
(retiring the GitHub Actions workaround, which works fine today but is a
second scheduling system), a longer function-timeout ceiling for future
long jobs, and any-past-deployment Instant Rollback. Nothing here is
blocking today — this is the user's call to make, not this spec's.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gdeploy-1: `MIGRATIONS.md`/`DEPLOYMENT.md` contradict `vercel.json`'s real auto-migrate-in-build behavior | P0 | `vercel.json:2` vs `MIGRATIONS.md:6-16`, `DEPLOYMENT.md:196-206` (3b) |
| Gdeploy-2: 5 pending commits never pushed to `origin/main`; CI never ran on them | P0 | `git log origin/main..main`; `gh run list --workflow=ci.yml` (3a) |
| Gdeploy-3: Migrations run non-transactionally under neon-http and are never dry-run before the live prod build | P0 | `neon-http/migrator.js:20-33`, `neon-http/session.js:151-158`; no pre-prod dry-run step exists (3b) |
| Gdeploy-4: `prod-smoke.sh` skips `/api/health` and every admin/money page beyond the login shell | P1 | `prod-smoke.sh:13-48` vs `src/app/api/health/route.ts` (3d) |
| Gdeploy-5: `DEPLOYMENT.md`'s required-env-var list is stale | P1 | `DEPLOYMENT.md:20-39` vs `env-validation.ts:23-148` (3c) |
| Gdeploy-6: No written procedure for app-rollback-vs-already-ran-migration | P1 | `vercel.com/docs/instant-rollback`; `MIGRATIONS.md` silent on rollback (3e) |
| Gdeploy-7: ~47 of ~65 code-referenced env vars aren't in the validated list; degrade-safe behavior sampled, not exhaustive | P2 | grep vs `env-validation.ts` (3c) |
| Gdeploy-8: Vercel-production env set unverifiable against local/code-referenced vars in this read-only pass | P2 | task scope excluded `vercel env` (3c) |

## 5. Requirements

- **Rdeploy-1** (Gdeploy-1): `MIGRATIONS.md` and `DEPLOYMENT.md` must state
  correctly that migrations run automatically in every production build,
  and a failed migration fails the whole build (old deployment stays live).
  **Acceptance**: rewritten sections match `vercel.json:2`; no remaining
  sentence claims a separate manual trigger is needed for a normal deploy.
- **Rdeploy-2** (Gdeploy-3, mechanism): every new migration must be
  idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP ... IF EXISTS`;
  no bare `DROP COLUMN`/`RENAME` without an explicit forward-compat note).
  **Acceptance**: `MIGRATIONS.md` states this as a hard rule; a small grep
  script flags bare `CREATE TABLE`/`ADD COLUMN` without `IF NOT EXISTS` and
  bare `DROP`/`RENAME` in new/changed `drizzle/*.sql`, wired into CI.
- **Rdeploy-3** (Gdeploy-3, process): before any prod deploy carrying a new
  migration, run `npm run db:migrate` against the DEV branch first and
  confirm 0 errors. **Acceptance**: written into the runbook as a required
  pre-deploy step.
- **Rdeploy-4** (Gdeploy-4): `prod-smoke.sh` asserts `/api/health` returns
  200/`database:"up"`, plus authenticated GETs on invoices, dispatch, and
  estimates expecting 200. **Acceptance**: run against current prod shows
  `ok` on all four new checks; a deliberately broken page shows `FAIL`.
- **Rdeploy-5** (Gdeploy-5): `DEPLOYMENT.md`'s required-vars block must
  match `REQUIRED_ENV_VARS` exactly (5 required vars; `AI_API_KEY` not
  `ANTHROPIC_API_KEY`). **Acceptance**: side-by-side diff shows no mismatch.
- **Rdeploy-6** (Gdeploy-6): write a rollback runbook: what Hobby Instant
  Rollback does/doesn't do, and the decision rule — app-only rollback for
  pure app-code bugs, a new forward-fix migration + redeploy for
  data/schema bugs, never a DB rollback. **Acceptance**: exists, under ~40
  lines, followable during an incident in under 2 minutes.
- **Rdeploy-7** (Gdeploy-2, the immediate task): ship the 5 pending commits
  via (1) `git push origin main`, CI green on the real SHA; (2) Rdeploy-3's
  dev-branch dry run for `0041`–`0044`; (3) `vercel deploy --prod --yes`;
  (4) the Rdeploy-4-expanded `prod-smoke.sh`; (5) watch Vercel logs/Sentry
  for ~10 minutes (manual — no automated alert pipeline exists).
  **Acceptance**: sequence is actually followed; smoke is green after.

## 6. Non-goals

- Staging environment, blue-green/canary, Kubernetes, CI/CD platform swap —
  disproportionate (Brainstorm).
- Migration-driver rewrite for real transactions — idempotency (Rdeploy-2)
  is the proportionate fix.
- Redis rate limiting, secrets vault, auto-rollback bot — out of scope /
  no supporting signal exists yet.
- New CI job running the full buildCommand against a live DB on every PR —
  the DEV-branch manual dry run is the proportionate version.
- Gdeploy-7/8 (P2) — not fixed now; sampled evidence already supports the
  degrade-safe convention. Revisit only if a specific var is found to 500.
- The Hobby-vs-Pro decision itself — 3g lays out the tradeoff; the call
  belongs to the user.

## 7. Invariants

- `git push` does not reliably trigger a Vercel build; deploys are always
  the explicit `vercel deploy --prod --yes` + `prod-smoke.sh` sequence.
- Migrations are forward-only — fixed by a new migration, never rewritten
  or rolled back. Rollback (Rdeploy-6) only ever repoints app-code traffic.
- neon-http has no real transactions (`db.transaction()` throws,
  `db.batch()` only) — applies to migrations too; idempotency is the only
  safety net.
- `.env.local` is the DEV Neon branch — never point it, or Rdeploy-3's
  dry run, at prod (`ep-withered-hill`).
- `CRON_SECRET`-gated cron routes fail closed if unset — any new sub-daily
  GitHub-Actions cron must reuse `cron-auth.ts`, not a bespoke check.
- FROZEN: `src/lib/ai` safety prompt text and `output-guardrail.ts` regex
  shapes are untouched by this program.
- The `VERCEL_ENV` guard on migrations stays (`migrate.ts:15-21`) — preview
  builds share prod's `DATABASE_URL`; removing it lets an abandoned PR
  silently alter production schema.

## 8. Verification

- `npx tsc --noEmit` → 0; `npx eslint <changed>` → 0; `npx vitest run` →
  no drop below 321 files / 4239 passed / 1 skipped; `verify-skills.mjs` →
  0 missing. (This spec changes docs + `prod-smoke.sh` + one small
  idempotency-check script — no app source expected — run the gates anyway.)
- Rdeploy-1: read-through of rewritten docs against `vercel.json:2` — no
  contradiction remains.
- Rdeploy-2: run the idempotency check against `0041`–`0044` (passes today)
  and a deliberately bad fixture (bare `DROP COLUMN`) — confirms it fails.
- Rdeploy-3/7: `DATABASE_URL=<dev> npm run db:migrate` clean before the real
  `vercel deploy --prod --yes`.
- Rdeploy-4: `prod-smoke.sh` run pre-change against current prod (confirms
  additive, no break to the existing green baseline), then for real
  post-deploy per Rdeploy-7.
- Rdeploy-5: diff `DEPLOYMENT.md` vs `env-validation.ts`'s required set —
  exact match.
- Rdeploy-6: runbook read end-to-end under 2 minutes, answers "bad
  migration just shipped, now what" without contradicting forward-only.
- Rdeploy-7: full sequence executed — push, CI green, dry run clean,
  deploy, smoke all `ok`, no new Sentry errors in the following ~10 minutes.
