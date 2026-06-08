-- Telephone channel + long-conversation summary.
--
-- Adds the session_channel enum and two columns to customer_sessions:
--   * channel — the medium a conversation arrived over ("web" widget chat, the
--     default for every existing row, or "phone" for a Twilio voice call).
--   * running_summary — a rolling natural-language summary of turns that have
--     aged out of the model's sliding window, so long conversations stay
--     coherent without re-sending the whole transcript. NULL until the first
--     compaction.
-- Plus an (organization_id, channel) index backing the admin channel filter.
--
-- Hand-authored (not drizzle-kit generated): migration 0008 introduced a
-- trigger with no schema diff, leaving the meta journal in a state where
-- drizzle-kit generate reports a snapshot collision. This migration is written
-- and snapshotted by hand to match that established pattern.

CREATE TYPE "public"."session_channel" AS ENUM('web', 'phone');
--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD COLUMN "channel" "session_channel" DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD COLUMN "running_summary" text;
--> statement-breakpoint
CREATE INDEX "sessions_org_channel_idx" ON "customer_sessions" USING btree ("organization_id","channel");
