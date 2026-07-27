# Database Aggressive-Tidy Plan

**Date:** 2026-07-27
**Branch:** feat/tech-location-autodispatch
**Status:** PLANNING — nothing in this plan has been applied. The apply artifact
(`drizzle/0043_aggressive_tidy.sql`) is a **DRAFT for controller review**, not an
executed migration.
**Scope:** 65 tables + all columns audited against live Neon row counts and `src/`
code references, cross-checked against the money/safety DO-NOT-TOUCH override list.

---

## Ground rules (read before touching anything)

1. **The money/safety DO-NOT-TOUCH list OVERRIDES every DROP/PRUNE/TRUNCATE below.**
   If a table or column appears on that list, it does not get dropped or truncated
   regardless of row count or code-reference count. Zero rows is *not* evidence of
   deadness for an idempotency ledger, a consent table, or a not-yet-exercised feature.

2. **DROP qualifies only when ALL of these hold:** `rowCount == 0` **AND**
   `codeRefs == 0` **AND** `featureWired == false` **AND** not on the DO-NOT-TOUCH
   list. The audit found **zero** tables and **zero** columns meeting this bar.

3. **Reversibility is asymmetric — this is the whole reason to be conservative:**
   - **Schema changes (DROP TABLE / DROP COLUMN) are git-revertable but the DATA is not.**
     Reverting the migration file re-creates the *empty* structure; every row/value
     that lived in the dropped object is gone permanently (Neon PITR aside, which we
     do not rely on for correctness).
   - **PRUNE (DELETE/UPDATE of rows) is NOT git-revertable at all.** There is no
     migration to revert — the rows are simply gone. This is why every prune below
     targets only *terminal* or *past-window* rows whose loss changes no live behavior.
   - Consequence: we bias hard toward KEEP. Reclaiming a few dozen dead rows is never
     worth risking a money/consent/audit seam.

4. **neon-http constraint:** no `db.transaction()` at runtime. The draft SQL is a
   single migration file applied by the migrator (which wraps statements itself); if
   the controller runs the prune predicates by hand, run them as individual statements
   or via `db.batch()` — never `db.transaction()`.

---

## Section 1 — DROP tables

**Qualifying candidates: 0.**

No table in the audit satisfies `rowCount 0 AND codeRefs 0 AND !featureWired AND
!doNotTouch`. Every zero-row table falls into one of three non-droppable buckets:

| Bucket | Examples | Why it survives |
|---|---|---|
| Wired feature, not yet exercised | `widget_keys`, `technician_availability`, `dispatch_decisions`, `custom_field_definitions`, `customer_locations`, `demand_daily`, `revenue_daily`, `forecast_snapshots`, `customer_threads`/`customer_events` | `codeRefs > 0` and an active read/write path exists; empty only because the single-tenant demo has not triggered the cron/flow yet. |
| Idempotency ledger (must stay near-zero) | `fieldpulse_webhook_events`, `hcp_webhook_events`, `saas_billing_events`, `capacity_reservations` | Emptiness is the *expected steady state*. The next webhook/confirm writes into it; dropping removes the atomic dedupe guard. On DO-NOT-TOUCH. |
| Consent / money / audit seam | `communication_preferences`, `financing_applications`, `technician_time_entries`, `membership_visits`, `platform_audit_log` | On DO-NOT-TOUCH. Dropping removes a legal/financial enforcement point. |

**Verdict: DROP zero tables.** This is the correct, honest outcome for a live
single-org product where "empty" overwhelmingly means "not yet used," not "dead."

---

## Section 2 — DROP columns

**Qualifying candidates: 0.**

Every column examined in the audit (`customers.notes`, `customers.anonymizedAt`,
`invoices.fieldpulseInvoiceId`, `payments.amountRefundedCents`, the FP-parity
spillover fields on `service_requests`/`estimates`/`invoices`, the dispatch home-base
and consent columns on `users`, the Stage-5 equipment lifecycle columns, etc.) has an
**active read or write reference in `src/`**. Several are explicit money/consent
discriminators on the DO-NOT-TOUCH list and must not even be renamed:

- `invoices.fieldpulseInvoiceId`, `invoices.hcpInvoiceId` — block native money flows on mirrored invoices.
- `payments.amountRefundedCents` — the CAS column for the atomic double-refund guard.
- `customers.doNotService` — booking-refusal gate.
- `customers.anonymizedAt` — GDPR erasure marker.
- `communication_preferences.doNotContact` — global comms opt-out.
- `revenue_daily.basis` — native/synced non-blend invariant.
- `technician_time_entries.laborRateCents` — immutable historical labor rate.

**Verdict: DROP zero columns.**

---

## Section 3 — PRUNE data (row-level deletes/updates)

Three low-risk targets. Each is a leaf table (verified: no other table FK-references
`communication_jobs`, `fp_import_runs`, or `outbound_message_ledger` in
`schema.ts`), so deleting rows cannot orphan a child. Predicates and column names were
verified against `src/lib/db/schema.ts`.

**Reminder: these deletes are irreversible and there is no revert migration. Only
terminal / past-window rows are targeted.**

### 3.1 `communication_jobs` — delete cancelled terminal jobs

```sql
DELETE FROM communication_jobs WHERE status = 'cancelled';
```

- **Est. rows:** 4
- **Why safe:** All 4 rows are `status = 'cancelled'` (terminal). The job processor's
  hot-path index (`communication_jobs_status_scheduled_idx`) is partial on
  `status IN ('pending','failed')`, so cancelled rows are never re-read for
  processing. No FK points at this table. Recipient PII columns are encrypted and
  carry no downstream reference once the job is cancelled.
- **Not on DO-NOT-TOUCH.** The *table* stays; only 4 dead rows go.

### 3.2 `fp_import_runs` — mark stuck 'running' rows as 'failed' (UPDATE, not DELETE)

```sql
UPDATE fp_import_runs
SET status = 'failed',
    finished_at = NOW(),
    error = 'stuck: no finished_at after 24h, marked failed by tidy audit'
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '24 hours';
```

- **Est. rows:** 3 (the jobs/invoices/customers phases stuck 'running' for ~18 days).
- **Why safe:** A serverless import cannot legitimately run for 18 days (Vercel
  function timeout is minutes). These are crashed runs whose misleading 'running'
  status pollutes the observability ledger. **UPDATE not DELETE** — we preserve the
  crash evidence (and the `counts.lastPage` resumability cursor) rather than erase it.
  A future completed run is a new row and is unaffected.
- **Guard:** the `started_at < NOW() - INTERVAL '24 hours'` predicate cannot touch a
  currently-executing import (which would be minutes old), so this is safe even if a
  sync happens to be mid-flight.

### 3.3 `outbound_message_ledger` — delete rows past their dedup window

```sql
DELETE FROM outbound_message_ledger WHERE created_at < NOW() - INTERVAL '30 days';
```

- **Est. rows:** 4 (of 8; the pre-2026-07-01 rows).
- **Why safe:** This ledger's only job is to make an outbound cron's
  `(org, customer, triggerType, periodKey)` claim atomic *within* a period window.
  Once a `periodKey` bucket (e.g. `"2026-06-24"`) is past, no cron re-fires for that
  exact tuple, so the row can never again block a legitimate send. Pruning past-window
  rows shrinks the unique index with zero correctness impact. The 4 July rows stay.
- **DO-NOT-TOUCH note:** the *table itself* is on the DO-NOT-TOUCH list as an
  audit/dedupe ledger. That override forbids **dropping the table or its unique
  index** — it does **not** forbid expiring past-window rows, which is exactly the
  maintenance this ledger is designed for (mirrors the 90-day webhook-event cleanup
  cron already in the codebase). We keep the table, the index, and every in-window row.

**Total prunable now: ~11 rows across 3 tables** (4 delete + 3 update + 4 delete).

---

## PROPOSED — needs human confirm (NOT in the apply list)

These are defensible but borderline; the controller decides. None are in
`0043_aggressive_tidy.sql`.

1. **`fp_import_runs` completed-row retention (90d).** The audit's rationale suggests
   pruning `status='completed'` rows older than 90 days. Right now *all* completed
   rows are < 30 days old, so there is **nothing to prune** — including a predicate
   would be a no-op today and risks silently deleting observability history the moment
   rows age past 90d without a human re-reviewing. **Recommendation: implement as a
   scheduled cleanup cron (like the existing webhook-cleanup), not a one-shot
   migration.** Deferred.

2. **`communication_jobs` retention for `status='sent'`/`'failed'` terminal rows.**
   Not requested by the audit and there are no such rows today. A time-based retention
   sweep belongs in a cron, not a tidy migration. Deferred.

3. **Anything touching `revenue_daily`, `saas_billing_events`, `membership_visits`,
   `dispatch_decisions`, `customer_threads`/`customer_events`.** Explicitly flagged in
   the money/safety notes as seams that must survive a tidy even when empty. **Hard
   no** — listed here only to record that they were considered and rejected.

---

## Apply / rollback runbook (for the controller)

1. **Review `drizzle/0043_aggressive_tidy.sql`.** It contains only Section 3's three
   predicates (2 DELETE + 1 UPDATE). No DDL. No DROP.
2. **Dry-run the row counts first** (read-only, run against prod Neon):
   ```sql
   SELECT count(*) FROM communication_jobs WHERE status = 'cancelled';                              -- expect ~4
   SELECT count(*) FROM fp_import_runs WHERE status='running' AND started_at < NOW() - INTERVAL '24 hours'; -- expect ~3
   SELECT count(*) FROM outbound_message_ledger WHERE created_at < NOW() - INTERVAL '30 days';       -- expect ~4
   ```
   If any count is wildly off from the audit, **stop** and re-audit — the env may have
   drifted since the audit snapshot.
3. **Apply** via the normal migrator (`npm run db:migrate`) or, if running by hand,
   execute the three statements individually / via `db.batch()` (NOT `db.transaction()`).
4. **Rollback:** the two DELETEs are **not** reversible — there is no down-migration
   and the rows are gone. The `fp_import_runs` UPDATE is reversible in principle (set
   the 3 ids back to `status='running'`) but there is no reason to. Do not apply if you
   are not comfortable with the deletes being permanent.

---

## Honest verdict

**Genuinely safe DDL: zero.** No table and no column met the DROP bar — and that is the
correct result, not a shortfall. This is a live, revenue-bearing single-tenant product;
the overwhelming majority of empty tables are wired features awaiting first use or
idempotency/consent ledgers whose empty state is by design. Aggressively dropping any of
them would trade a few kilobytes of empty schema for a real risk of severing a money,
consent, or audit seam.

The only defensible action is **row-level pruning of ~11 terminal/stale rows** across 3
leaf tables. Even that is optional housekeeping: it reclaims almost nothing and its main
value is correcting the 3 misleading `fp_import_runs` 'running' statuses (an UPDATE, not
a delete). If the controller wants maximum caution, applying *only* 3.2 (the status fix)
and skipping the two DELETEs is a perfectly reasonable, near-zero-value-but-zero-risk
choice.

**Bottom line:** little is genuinely safe to remove here — and for a database this
tightly coupled to money and compliance, that is exactly what a healthy schema looks
like.
