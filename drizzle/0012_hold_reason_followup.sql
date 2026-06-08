-- On-hold reason + follow-up date (Stage 2 of the ServiceTitan lifecycle work).
--
-- When a dispatcher pauses a job (status → on_hold) they record WHY (a
-- ServiceTitan-style hold reason) and optionally WHEN to revisit it, so the
-- queue shows what each held job is waiting on.
--
-- This is a CREATE TYPE + ADD COLUMN migration (not ALTER TYPE ... ADD VALUE),
-- so the neon-http file-migrator handles it normally. Hand-authored to match
-- the project's migration pattern (the meta journal carries a pre-existing
-- 0007/0008 snapshot collision that blocks drizzle-kit generate).

CREATE TYPE "public"."hold_reason" AS ENUM('awaiting_parts', 'awaiting_customer', 'awaiting_access', 'weather', 'other');
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "hold_reason" "hold_reason";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "follow_up_date" timestamp with time zone;
