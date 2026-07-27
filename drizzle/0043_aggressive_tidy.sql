-- ============================================================================
-- 0043_aggressive_tidy.sql — DRAFT (NOT YET APPLIED)
-- ============================================================================
-- Controller review required before running. This file is produced by the
-- DATABASE AGGRESSIVE-TIDY planning pass (docs/superpowers/plans/2026-07-27-db-aggressive-tidy.md).
--
-- DROP tables:  0  (no table met rowCount=0 AND codeRefs=0 AND !featureWired AND !doNotTouch)
-- DROP columns: 0  (every column examined has an active read/write ref in src/)
-- PRUNE:        3 predicates (2 DELETE + 1 UPDATE) over leaf tables only.
--
-- REVERSIBILITY WARNING: the two DELETEs below are IRREVERSIBLE. There is no
-- down-migration; deleted rows are gone permanently. Only terminal / past-window
-- rows are targeted. Dry-run the COUNT() checks in the plan runbook before applying.
--
-- neon-http: apply via the migrator or db.batch() — NOT db.transaction().
-- ============================================================================

-- 3.1 communication_jobs — delete terminal 'cancelled' jobs.
-- Leaf table (no FK dependents). Processor hot-path index is partial on
-- status IN ('pending','failed'), so cancelled rows are never re-read. ~4 rows.
DELETE FROM communication_jobs WHERE status = 'cancelled';--> statement-breakpoint

-- 3.2 fp_import_runs — mark stuck 'running' rows as 'failed' (UPDATE, not DELETE).
-- Preserves crash evidence + counts.lastPage cursor. 24h guard cannot touch a
-- currently-executing (minutes-old) import. ~3 rows (stuck ~18 days).
UPDATE fp_import_runs
SET status = 'failed',
    finished_at = NOW(),
    error = 'stuck: no finished_at after 24h, marked failed by tidy audit'
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '24 hours';--> statement-breakpoint

-- 3.3 outbound_message_ledger — delete rows past their 30-day dedup window.
-- Table + unique index are KEPT (on DO-NOT-TOUCH); only past-window rows expire,
-- which is the maintenance this ledger is designed for. ~4 rows. In-window (July)
-- rows are retained.
DELETE FROM outbound_message_ledger WHERE created_at < NOW() - INTERVAL '30 days';
