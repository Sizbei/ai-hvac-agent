# Page program — index

Spec → adversarial review → plan → adversarial review → build → adversarial
review, run for all 30 pages. Method in [METHOD.md](./METHOD.md).

- **Started:** 2026-08-11
- **Test baseline at start:** 297 files · 4022 passed · 1 skipped (all green)
- **Branch:** `main`

## Layout

| Path | Holds |
|---|---|
| `specs/<slug>.md` | Per-page spec (brainstorm, current state, gaps, requirements) |
| `plans/<slug>.md` | Implementation plan for the P0/P1 requirements |
| `reviews/` | Adversarial review round records (specs, plans, code) |
| `reports/` | Build reports from the development waves |
| `LEDGER.md` | Live status per page |

## Page inventory

| Cluster | Pages |
|---|---|
| public | home, chat, auth, portal, tech |
| customers | conversations, customers, reviews, communications, insights-ai |
| money | pricebook, estimates, invoices, accounting, membership-plans |
| operations | dashboard, calendar, dispatch, requests, technicians, map |
| workspace | reports, operations, staff, settings, integrations, inventory, audit-log, fieldpulse-import, platform |

Status per page lives in [LEDGER.md](./LEDGER.md).
