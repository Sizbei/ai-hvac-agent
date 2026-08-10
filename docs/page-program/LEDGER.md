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

## Shipped

Commits `3d4ca1e` (wave A/B), `fb27657` (wave C + promoted P0s), `766c5c1`
(final build wave), plus the round-2 review fixes.

Final gate: tsc 0 · eslint 0 · vitest **321 files / 4237 passed / 1 skipped**
(baseline 297 / 4022 / 1 — no drop, +215 tests).

### Wave C + promoted P0s (`fb27657`)

| Item | Page(s) | What landed |
|---|---|---|
| A12 | audit-log | Actor join organization-scoped — a provisioned org's audit page no longer discloses the platform admin's name |
| A13 | chat | `GET /api/chat/history` gated on the same verify state as A7 |
| B4 | estimates | Lazy CAS-guarded expiry sweep (native estimates can reach a terminal state, so win rate can fall); regenerable approval link; quantity/price caps |
| C2 | operations | Response-time and first-response KPIs exclude synced jobs |
| C6 | portal | History from `service_requests` (not the empty `service_history`); drafts hidden |
| DC-2 | communications | All 15 trigger types from one shared list |
| DC-3 | communications | Template delete refused when send history exists (no FK migration) |

### Final build wave (`766c5c1`)

| Item | Page(s) | What landed |
|---|---|---|
| B7 | invoices | `takePayment` state derived from the claim's `RETURNING` row — concurrent partial payments can't strand a paid invoice as "open" |
| C3b | dashboard | Overdue-invoices tile reusing `overdueWhere()` (a spy test proves the shared predicate runs) |
| C3c | insights-ai | `getBotAnalytics` batched; sections disclose their time window |
| C4 | fieldpulse-import | All 11 phases shown; stale-run detection |
| C5 | integrations | "Connected" flips to "Sync failed" from data already written and read by nothing |
| DC-1 | conversations | Reply composer for the unreachable takeover API; outcome/next-steps/mode rendered |
| DC-4 | tech | 44×44 tap targets (measured on the live DOM); confirmation before terminal status changes |

### Round-2 review fixes

| Finding | Fix |
|---|---|
| IR-1 | Estimate caps bounded the factors but not their product — `22 × $999,999.99` still overflowed int4 and 500'd. Now checks derived line totals and option totals after server-side price resolution. |
| IR-2 | New map-chip copy said "job"; canon is "request". |
| SR-1 | Analytics masking missed `/admin/invite/[token]`, a real single-use staff-invite credential. Prefix matcher now handles nested routes. |
| SR-2 | `membership-account` mapped to a real account capability with no verify entry. Gated, and `account-verify.contract.test.ts` now fails if the two maps ever drift again. |
| IR-3 | This ledger was stale against its own later commits. |

### Wave A/B (`3d4ca1e`)

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

## Follow-ups the build surfaced (not silently dropped)

Each was found while implementing something else and deliberately left out of
scope rather than done half-way.

**Real defects, not yet fixed**

1. **Template variables fail silently at send time.** `renderSmsTemplate`
   compiles with Handlebars `strict: true`, so a variable that doesn't exist
   THROWS at render. `validateSmsTemplate` only checks syntax at save time —
   it never renders against `templateVariableSchemas` for the trigger type. So
   a misspelled variable saves fine, then throws on every real send, retries
   3×, and lands in `failed`. The customer receives nothing and nobody is told.
2. **Membership enrolment charge is never ledgered** (`enrollCustomer`'s
   `chargeFirstPeriod`). Harmless only because the Stripe adapter is mocked.
   **This becomes a release blocker the day a real payment adapter lands.**
3. **Chat's rate limiter is per-instance** (`src/lib/rate-limit.ts` is a bare
   in-memory `Map`) on the product's highest-cost surface — LLM spend. Fixing
   it properly needs shared state this deployment doesn't have.
4. **HCP integration never writes to `payments`**, so synced HCP invoices get
   no cash line in the accounting export — the export's "for reconciliation"
   promise is unkeepable for HCP-only orgs.
5. **`org_provisioned` never reaches `platform_audit_log`** (it writes to the
   new org's own `audit_log`), so a platform audit viewer would be blind to
   tenant provisioning.

**UI/server gate mismatches** — the server is authoritative and correct in each
case; the UI just still offers a control that now returns 403/409:

6. Platform console still renders Purge for the platform's own org.
7. Conversation delete button shows for non-super-admins.
8. Integration panels don't self-hide for non-super-admins.
9. Integration *status* GET routes were left ungated (only connect/disconnect
   were in scope); `settings.md` wanted those too.

**Cosmetic / stale text**

10. `staff-queries.ts` comments still cite "migration 0008"; the guard is now
    `drizzle/0044`.
11. `CHAT_VERIFY_PASSED` copy still says "balance or membership" though every
    account intent is now gated.
12. `accounting-export.ts`'s `buildCsv` sums already-converted float dollars
    rather than integer cents — inert at current scale, but the anti-pattern
    the file's own header warns against.

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
