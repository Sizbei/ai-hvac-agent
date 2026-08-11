# Database Migrations — Runbook

Migrations are **forward-only** Drizzle SQL files in `drizzle/`, applied by
`npm run db:migrate` (`src/lib/db/migrate.ts`, Neon HTTP migrator).

## Migrations DO auto-run on deploy

`vercel.json` sets `"buildCommand": "npm run db:migrate && next build"`, so
**every production deploy applies pending migrations before the app is built**.
By the time a deploy reports Ready, the database has already changed.

> This section previously said the opposite ("Vercel's build does not run
> migrations… applied manually, on demand"). That was stale and actively
> dangerous: an operator following it during an incident would run migrations a
> second time, or assume the schema was untouched when it was not. Verified
> against `vercel.json` on 2026-08-11.

Two consequences that shape how you release:

- **The migration is the one-way door, not the deploy.** Vercel Instant
  Rollback restores the previous *build*; it cannot un-run a migration. On the
  Hobby plan you can only roll back one deployment. Judge a release by whether
  its migration is safe to have applied.
- **Migrations must be forward-compatible with the currently-running code**,
  because old instances keep serving traffic while the new build rolls out.

Schema drift (a migration committed but never applied) shows up as 500s on
writes that use `.returning()`. Deploying is what applies it.

The manual paths below still exist and are the right tool for applying a
migration WITHOUT shipping code — e.g. to a dev branch, or to pre-apply and
verify a risky migration before the deploy that assumes it.

See `docs/deploy-money-program/DEPLOY-RUNBOOK.md` for the full release
sequence and rollback procedure.

## How to run migrations

> **You usually do not need either option.** A production deploy applies pending
> migrations by itself (see the top of this file). Reach for the options below
> only when you need to migrate *without* deploying: a preview or scratch
> database (preview builds deliberately skip migrations), or a schema fix you
> want applied before the code that depends on it ships.

### Option A — GitHub Actions (manual, out-of-band)

1. Open the repo's **Actions** tab → **Migrate (manual)** workflow.
2. Click **Run workflow**, pick the target `environment`, and run.
3. The job is **degrade-safe**: if the `DATABASE_URL` repo/environment secret is
   absent, it **skips with a warning** (no-op) instead of failing. With the
   secret present, it runs `npm run db:migrate` against that database.

> The actual database targeted is whatever the `DATABASE_URL` **secret** points
> at. The `environment` input is an informational label — make sure the secret
> for the chosen environment is the one wired into the workflow.

### Option B — Local (against an explicit DATABASE_URL)

```bash
# Put the target DB URL in .env.local (or export DATABASE_URL), then:
npm run db:migrate
```

`migrate.ts` loads `.env.local`, but an already-exported `DATABASE_URL` env var
takes precedence — so CI/operator-set env vars win over the file.

## Rules

- **Forward-only.** Never re-squash or rewrite applied migrations.
- **One environment at a time.** Confirm which DB `DATABASE_URL` points at
  before running. There is no built-in dry-run; review the SQL in the new
  `drizzle/*.sql` file before applying.
- **After applying**, verify the app's `.returning()` write paths (e.g. create a
  request / invoice) succeed.

## Verify before running (manual dry check)

```bash
# Inspect the pending SQL that will be applied:
ls -t drizzle/*.sql | head
# Generate (does not apply) any uncommitted schema changes:
npm run db:generate
```
