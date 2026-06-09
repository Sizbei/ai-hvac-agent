-- Invoice / payment status synced from Housecall Pro invoice.* webhooks.
-- (Stage 4 of the HCP integration.)
--
-- HCP emits invoice.* events (invoice.sent, invoice.paid, invoice.voided) after
-- a job. We mirror that status onto OUR service_request (linked by hcp_job_id)
-- so admins see whether a completed job has been invoiced/paid. The webhook
-- handler maps the event type to one of these enum values and updates the
-- matching request idempotently (the hcp_webhook_events ledger dedupes
-- redeliveries; an unlinkable/unknown event is a safe no-op).
--
-- This is a CREATE TYPE + ADD COLUMN migration (not ALTER TYPE ... ADD VALUE),
-- so the neon-http file-migrator handles it normally. The column is NOT NULL
-- with a 'none' default, so existing rows backfill to 'none' (no invoice
-- activity yet) without a separate UPDATE. Hand-authored to match the project's
-- migration pattern.

CREATE TYPE "public"."invoice_status" AS ENUM('none', 'sent', 'paid', 'void');
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "invoice_status" "invoice_status" DEFAULT 'none' NOT NULL;
