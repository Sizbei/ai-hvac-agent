-- Two new service-request lifecycle stages (ServiceTitan-aligned):
--   * "scheduled" — booked with an arrival window, before/independent of a tech
--     actively working the job. Ordered right after "assigned".
--   * "on_hold"   — paused (waiting on parts, customer callback, access).
--     Resumable. Ordered right after "in_progress".
--
-- Postgres enum values are added in place with ALTER TYPE ... ADD VALUE. We use
-- IF NOT EXISTS so the migration is idempotent, and BEFORE/AFTER to place each
-- value at the right sort position rather than appending at the end.
--
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- Postgres. The neon-http file-migrator (drizzle-orm/neon-http/migrator) was
-- observed to FAIL on this file ("syntax error at or near 'chunk'"), so on the
-- live DB these two statements were applied out-of-band via the neon driver
-- (each statement autocommits) and 0011 was then recorded in
-- drizzle.__drizzle_migrations. For a FRESH database, if `npm run db:migrate`
-- errors on this file, run these two ALTER TYPE statements directly against the
-- DB (e.g. psql / a one-off neon() call), then insert the 0011 journal row.
-- IF NOT EXISTS keeps that safe to repeat.

ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'scheduled' AFTER 'assigned';
--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'on_hold' AFTER 'in_progress';
