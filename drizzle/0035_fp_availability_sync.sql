-- Fieldpulse Availability Sync Tracking
--
-- Stage 9: Add tracking columns for technician availability sync from Fieldpulse.
-- This enables:
-- 1. Monitoring when the last successful sync occurred
-- 2. Tracking sync status (pending, in_progress, completed, failed)
-- 3. Displaying sync state in the admin UI
-- 4. Troubleshooting sync failures
--
-- These columns are added to fieldpulse_connections since sync is per-organization
-- and tied to the Fieldpulse API credentials.

-- Add last availability sync timestamp (null = never synced)
ALTER TABLE "fieldpulse_connections" ADD COLUMN "last_availability_sync_at" timestamp with time zone;

-- Add availability sync status enum
CREATE TYPE "availability_sync_status" AS ENUM ('pending', 'in_progress', 'completed', 'failed');

-- Add availability sync status column
ALTER TABLE "fieldpulse_connections" ADD COLUMN "availability_sync_status" "availability_sync_status";

-- Add error message column (null = no error or last sync succeeded)
ALTER TABLE "fieldpulse_connections" ADD COLUMN "last_sync_error" text;

-- Set default values for existing connections
UPDATE "fieldpulse_connections"
SET "availability_sync_status" = 'pending'
WHERE "availability_sync_status" IS NULL;

-- Make status column NOT NULL with default
ALTER TABLE "fieldpulse_connections" ALTER COLUMN "availability_sync_status" SET NOT NULL;
ALTER TABLE "fieldpulse_connections" ALTER COLUMN "availability_sync_status" SET DEFAULT 'pending';

-- Comments for documentation
COMMENT ON COLUMN "fieldpulse_connections"."last_availability_sync_at" IS 'Timestamp of last successful availability sync from Fieldpulse (null = never synced)';
COMMENT ON COLUMN "fieldpulse_connections"."availability_sync_status" IS 'Current status of availability sync: pending, in_progress, completed, or failed';
COMMENT ON COLUMN "fieldpulse_connections"."last_sync_error" IS 'Error message from last failed sync (null = no error)';

-- Index for filtering connections by sync status (useful for admin UI)
CREATE INDEX "fieldpulse_connections_sync_status_idx" ON "fieldpulse_connections" USING btree ("availability_sync_status")
WHERE "connected" = true;
