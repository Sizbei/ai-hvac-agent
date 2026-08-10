# Page program — index

Spec → adversarial review → plan → adversarial review → build → adversarial
review, run for all 30 pages. Method in [METHOD.md](./METHOD.md).

- **Started:** 2026-08-11
- **Test baseline at start:** 297 files · 4022 passed · 1 skipped (all green)
- **Branch:** `main`

## Outcome

Complete. Four build commits (`3d4ca1e`, `fb27657`, `766c5c1`, `b5a9cfc`) on
top of `7787352`.

- **Final gate:** tsc 0 · eslint 0 · `verify-skills` 388 paths / 0 missing ·
  vitest **321 files / 4239 passed / 1 skipped**, green on three consecutive
  runs (baseline 297 / 4022 / 1).
- **Not deployed.** `vercel deploy --prod --yes` was not run — that is the
  user's call. Migration `drizzle/0044` runs in the Vercel build and is
  idempotent, so it is safe on databases that already have the trigger.
- **Verdict:** ship-with-fixes from all four code-review lenses; every
  blocker- and major-rated finding was fixed and re-gated. Zero blockers
  remained. The residual minors and known gaps are listed in
  [LEDGER.md](./LEDGER.md) under "Follow-ups the build surfaced".

The single most consequential find: the public chat widget disclosed a real
customer's appointments and past conversations to anyone who knew their phone
number — a self-reported contact match linked the session, and only two of the
five account intents were verification-gated.

## Layout

| Path | Holds |
|---|---|
| `specs/<slug>.md` | Per-page spec (brainstorm, current state, gaps, requirements) |
| `PLAN.md` | The consolidated implementation plan, with reviser decisions |
| `reviews/` | 21 adversarial review records (15 on specs, 3 on the plan, 4 on the code) |
| `LEDGER.md` | What shipped, and the follow-ups the build surfaced |

## Page inventory

| Cluster | Pages |
|---|---|
| public | home, chat, auth, portal, tech |
| customers | conversations, customers, reviews, communications, insights-ai |
| money | pricebook, estimates, invoices, accounting, membership-plans |
| operations | dashboard, calendar, dispatch, requests, technicians, map |
| workspace | reports, operations, staff, settings, integrations, inventory, audit-log, fieldpulse-import, platform |

Status per page lives in [LEDGER.md](./LEDGER.md).
