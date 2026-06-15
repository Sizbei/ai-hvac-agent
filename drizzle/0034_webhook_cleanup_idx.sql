-- Webhook Event Cleanup Index
--
-- Stage 14: Add created_at indexes to webhook event tables to support efficient
-- 90-day retention cleanup. The cron job /api/cron/webhook-cleanup will
-- periodically delete events older than 90 days. Without these indexes, the
-- cleanup query would require a full table scan on large webhook event tables.
--
-- Both hcp_webhook_events and fieldpulse_webhook_events already have:
-- - org_id_idx for organization lookup
-- - org_event_unique for idempotency
--
-- This migration adds created_at indexes specifically for cleanup performance:
-- - Partial index (created_at) for WHERE created_at < NOW() - INTERVAL '90 days'
-- - Covers both tables, same pattern as hcp_webhook_events

-- Index for HCP webhook events cleanup
CREATE INDEX "hcp_webhook_events_created_at_idx" ON "hcp_webhook_events" USING btree ("created_at");

-- Index for Fieldpulse webhook events cleanup
CREATE INDEX "fieldpulse_webhook_events_created_at_idx" ON "fieldpulse_webhook_events" USING btree ("created_at");

-- Document the cleanup purpose
COMMENT ON INDEX "hcp_webhook_events_created_at_idx" IS 'Supports efficient 90-day retention cleanup of HCP webhook events';
COMMENT ON INDEX "fieldpulse_webhook_events_created_at_idx" IS 'Supports efficient 90-day retention cleanup of Fieldpulse webhook events';
