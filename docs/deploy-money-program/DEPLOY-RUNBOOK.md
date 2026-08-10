# Deploy runbook

The exact sequence to ship this repo to production, and how to get back if it
goes wrong. Every constraint below was verified, not assumed — sources in
`FACTS.md`.

## Before you start — three facts that shape everything

1. **`git push` does NOT deploy.** This repo's Vercel project does not build on
   push. Deploys happen only via `vercel deploy --prod --yes`. Pushing is
   therefore free: it runs CI and nothing else.
2. **Migrations run inside the build** (`vercel.json` →
   `"buildCommand": "npm run db:migrate && next build"`). By the time the build
   finishes, the production database has already been altered.
3. **Rollback does not touch the database.** Vercel Instant Rollback restores
   the previous *build*; it cannot un-run a migration
   (`vercel.com/docs/deployments/instant-rollback`, fetched 2026-08-11). On
   **Hobby you can only roll back to the immediately previous deployment** —
   there is no "choose another deployment" option. And after a rollback Vercel
   **turns off production auto-assignment**, so nothing new goes live until you
   `vercel promote <url>` to undo it.

Together these mean: **the migration is the one-way door, not the deploy.**
Judge a release by whether its migration is safe to have run, because you
cannot take it back.

## The sequence

```bash
# 1. Confirm the tree is clean and pushed
git status --short          # expect empty
git status -sb | head -1    # expect no "ahead"

# 2. Confirm CI is green for the exact SHA you're shipping
gh run list --workflow=ci.yml --limit 1

# 3. Local gate (CI runs these too; this is the fast local echo)
npx tsc --noEmit                    # 0
npx vitest run                      # must not drop below 321 files / 4239 passed / 1 skipped
node scripts/agent/verify-skills.mjs  # 0 missing

# 4. Know your rollback target BEFORE you deploy — on Hobby it is the only one
vercel ls --prod | head -3          # note the current production URL

# 5. Deploy
vercel deploy --prod --yes

# 6. Verify immediately
bash scripts/agent/prod-smoke.sh    # all probes must pass
```

## What "good" looks like at step 6

The pre-deploy baseline (2026-08-11, against the 7-day-old build) was **8/8
passing**: home / chat / admin-login all 200, demo login works, demo erase and
demo SMS both correctly 403, mapkit-token 503 (expected — no Apple
credentials), chat streams. Chat TTFB was 3.96s.

Any probe that flips from pass to fail is attributable to the new build,
because production was healthy immediately before. That is the whole point of
capturing the baseline.

## If it goes wrong

**Fast path — the app is broken but the data is fine:**

```bash
vercel rollback            # Hobby: goes to the immediately previous deployment
bash scripts/agent/prod-smoke.sh
```

Then remember auto-assignment is now OFF. When you're ready to move forward
again: `vercel promote <good-deployment-url>`.

**The harder case — the migration is the problem.** Rollback will NOT help; the
schema change has already applied. Options, worst to best:

- Write a NEW forward migration that reverses the change, and deploy that.
  There is no `down` migration in this repo.
- Restore the Neon branch from a point-in-time snapshot. This loses every write
  since that point — for a live HVAC business that means lost requests,
  invoices and payments. Treat as a last resort.

This is why the migration deserves more scrutiny than the code.

## This release specifically

Shipping `7787352..082421b` (7 commits: the page program's security, money and
data-honesty fixes).

- **CI:** run `31419465582` — **success**.
- **Migration:** `drizzle/0044_last_admin_guard.sql`, the only one in this
  release. It re-creates the last-admin lockout trigger that a 2026-06-16
  squash dropped. It is **idempotent** (`CREATE OR REPLACE FUNCTION`, plus
  `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`), which matters because the
  trigger already exists on production — a non-idempotent version would fail
  the build. It adds no column and drops no data, so the "one-way door" risk
  for this particular release is low.
- **Forward-compatibility:** during a deploy, old instances still serve traffic
  against the new schema. `0044` only adds a trigger enforcing an invariant the
  application already enforced in code, so old instances remain correct.

## Standing rules

- Never point `.env.local` at production (`ep-withered-hill`). It is the DEV
  branch (`ep-patient-surf`) and must stay that way.
- Never deploy with a dirty working tree — you cannot tell afterwards what
  shipped.
- Capture the smoke baseline BEFORE deploying, every time. A post-deploy
  failure is only diagnostic if you know the pre-deploy state.
