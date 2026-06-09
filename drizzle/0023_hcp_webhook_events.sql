-- Inbound Housecall Pro (HCP) webhooks: idempotency ledger + per-org webhook secret.
--
-- Stage 5 closes the loop: HCP -> us. HCP POSTs a signed event whenever a job's
-- status changes; we verify the HMAC-SHA256 signature, map the event to our
-- request-status state machine, and update the matching service_request.
--
-- Two changes here:
--   1. `hcp_webhook_events` — an IDEMPOTENCY ledger. HCP retries delivery, so the
--      same event id can arrive multiple times. The unique (org, event_id) index
--      lets the handler insert-on-conflict-do-nothing and treat a zero-row insert
--      as "already processed", so a redelivery never applies a second update. We
--      store only NON-secret metadata (event id, type, the referenced job id),
--      never the raw payload or any secret.
--   2. `housecall_pro_connections.webhook_secret_encrypted` — the per-org HCP
--      webhook SIGNING secret, stored ENCRYPTED at rest (AES-256-GCM via
--      @/lib/crypto, NEVER plaintext, NEVER logged). Optional: when null the
--      env-level HOUSECALL_WEBHOOK_SECRET is used; when neither is set the webhook
--      endpoint rejects everything (fail closed).
--
-- Plain CREATE TABLE + ADD COLUMN (nullable, no default) — no enum / ALTER TYPE,
-- so no in-transaction hazard; runs fine through the neon-http file migrator
-- (db:migrate).
CREATE TABLE "hcp_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"hcp_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "housecall_pro_connections" ADD COLUMN "webhook_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "hcp_webhook_events" ADD CONSTRAINT "hcp_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hcp_webhook_events_org_id_idx" ON "hcp_webhook_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_webhook_events_org_event_unique" ON "hcp_webhook_events" USING btree ("organization_id","event_id");
