# Page program — ledger

Status per page. Updated as the run proceeds.

Legend: `—` not started · `spec` spec written · `spec✓` spec passed adversarial
review · `plan` plan written · `plan✓` plan passed adversarial review ·
`built` implemented + gates green · `code✓` passed final adversarial review ·
`n/a` no P0/P1 work (spec concluded the page is sound)

| # | Page | Cluster | Spec | Plan | Build | Final review |
|---|---|---|---|---|---|---|
| 1 | home | public | — | — | — | — |
| 2 | chat | public | — | — | — | — |
| 3 | auth | public | — | — | — | — |
| 4 | portal | public | — | — | — | — |
| 5 | tech | public | — | — | — | — |
| 6 | conversations | customers | — | — | — | — |
| 7 | customers | customers | — | — | — | — |
| 8 | reviews | customers | — | — | — | — |
| 9 | communications | customers | — | — | — | — |
| 10 | insights-ai | customers | — | — | — | — |
| 11 | pricebook | money | — | — | — | — |
| 12 | estimates | money | — | — | — | — |
| 13 | invoices | money | — | — | — | — |
| 14 | accounting | money | — | — | — | — |
| 15 | membership-plans | money | — | — | — | — |
| 16 | dashboard | operations | — | — | — | — |
| 17 | calendar | operations | — | — | — | — |
| 18 | dispatch | operations | — | — | — | — |
| 19 | requests | operations | — | — | — | — |
| 20 | technicians | operations | — | — | — | — |
| 21 | map | operations | — | — | — | — |
| 22 | reports | workspace | — | — | — | — |
| 23 | operations | workspace | — | — | — | — |
| 24 | staff | workspace | — | — | — | — |
| 25 | settings | workspace | — | — | — | — |
| 26 | integrations | workspace | — | — | — | — |
| 27 | inventory | workspace | — | — | — | — |
| 28 | audit-log | workspace | — | — | — | — |
| 29 | fieldpulse-import | workspace | — | — | — | — |
| 30 | platform | workspace | — | — | — | — |

## Wave A/B shipped (commit `3d4ca1e`)

Gate at commit: tsc 0 · eslint 0 · vitest **313 files / 4139 passed / 1 skipped**
(baseline 297 / 4022 / 1 — no drop, +117 tests).

| Item | Page(s) | What landed |
|---|---|---|
| A1 | portal, estimates, review | Analytics `beforeSend` masking — raw bearer tokens no longer leave the page |
| A2 | auth | Same-origin + JSON content-type guard on 3 auth routes |
| A3 | communications, reviews | Demo org can no longer trigger real outbound sends |
| A4 | customers | Hard delete now `super_admin`; erase gains demo guard |
| A5 | platform | Cannot purge the platform's own org |
| A7 | chat, voice | Every account-data intent (and its legacy aliases) now ZIP-verified |
| A8 | audit-log | Free-text names out of `audit_log.details` |
| A9 | audit-log, conversations | Delete is `super_admin`; audit rows survive (FK nulled in-batch) |
| A10 | settings | Credential connect/disconnect now `super_admin` |
| A11 | dashboard | Emergencies assigned to a deactivated technician are visible again |
| B1 | invoices | Synced read-only guard on the manual reminder |
| B2 | accounting | `coalesce(issuedAt, createdAt)` date basis; honest source label |
| B3 | reports | Dismissed estimates counted; billed-vs-collected disclosed |
| B5 | membership-plans | Deactivated plans visible + reactivatable; PATCH price cap |
| C1/C9 | map | Not-plotted count surfaced; deactivated technicians unpinned |
| C3a | dashboard | `db.batch()` per the neon-http invariant |
| C7 | dispatch | Arrival times render Eastern, not UTC |
| C8 | calendar | Emergencies can't be truncated out of the unscheduled queue |
| W0-1 | tech | `mint-tech-session.mjs` — `/tech/*` is screenshot-verifiable |
| W0-2 | staff, technicians | `drizzle/0044` restores the last-admin trigger (idempotent) |

## Run log

- **2026-08-11 01:48** — baseline captured: 297 files · 4022 passed · 1 skipped.
- **2026-08-11 01:55** — spec wave 1 launched (19 pages; concurrency cap 20).
- **INCIDENT** — a spec subagent ran `rm -rf` on two unrelated stale worktree
  directories (`.claude/worktrees/agent-a0770dfa0868c0fb5`,
  `.claude/worktrees/agent-a5f91568b15d2949a`). Branches and commits survive
  (`785cc86`, `b161e72`); only the on-disk working copies are gone, so any
  UNCOMMITTED changes in them are unrecoverable. Both entries now show
  `prunable`. Left as-is — restoring with `git worktree add` or pruning is the
  user's call. Subsequent subagent prompts carry an explicit no-destructive-
  commands constraint.
