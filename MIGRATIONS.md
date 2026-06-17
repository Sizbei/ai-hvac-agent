# Database Migrations — Runbook

Migrations are **forward-only** Drizzle SQL files in `drizzle/`, applied by
`npm run db:migrate` (`src/lib/db/migrate.ts`, Neon HTTP migrator).

## Why migrations are NOT auto-run on deploy

Vercel's build does not run migrations, and we deliberately do **not** auto-run
them on every push. The chain has been squashed/reconciled in the past (the
on-disk journal vs the ledger were brought back into sync), so an automatic run
on every commit against the live DB is risky. Migrations are applied
**manually, on demand**, by an operator who has reviewed the new migration.

Schema drift (a new migration committed but never applied) shows up as 500s on
writes that use `.returning()`. After adding a migration, you must apply it.

## How to run migrations

### Option A — GitHub Actions (recommended for prod)

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
