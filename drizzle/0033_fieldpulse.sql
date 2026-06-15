-- Fieldpulse Integration
-- Adds tables and columns for Fieldpulse FSM integration

-- Fieldpulse API credentials per organization
CREATE TABLE "fieldpulse_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "api_key_encrypted" text,
  "webhook_secret_encrypted" text,
  "account_info" jsonb,
  "connected" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fieldpulse_connections_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "public"."organizations"("id")
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
);

-- Indexes for fieldpulse_connections
CREATE INDEX "fieldpulse_connections_org_id_idx" ON "fieldpulse_connections" USING btree ("organization_id");
CREATE UNIQUE INDEX "fieldpulse_connections_org_unique" ON "fieldpulse_connections" USING btree ("organization_id");

-- Fieldpulse webhook event idempotency ledger
CREATE TABLE "fieldpulse_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "fieldpulse_job_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fieldpulse_webhook_events_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "public"."organizations"("id")
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
);

-- Indexes for fieldpulse_webhook_events
CREATE INDEX "fieldpulse_webhook_events_org_id_idx" ON "fieldpulse_webhook_events" USING btree ("organization_id");
CREATE UNIQUE INDEX "fieldpulse_webhook_events_org_event_unique" ON "fieldpulse_webhook_events" USING btree ("organization_id", "event_id");

-- Add Fieldpulse customer mapping column
ALTER TABLE "customers" ADD COLUMN "fieldpulse_customer_id" text;

-- Add Fieldpulse job mapping column
ALTER TABLE "service_requests" ADD COLUMN "fieldpulse_job_id" text;

-- Comments for documentation
COMMENT ON TABLE "fieldpulse_connections" IS 'Per-org Fieldpulse API credentials (encrypted at rest)';
COMMENT ON TABLE "fieldpulse_webhook_events" IS 'Idempotency ledger for inbound Fieldpulse webhooks';
COMMENT ON COLUMN "customers"."fieldpulse_customer_id" IS 'Fieldpulse customer ID for job sync';
COMMENT ON COLUMN "service_requests"."fieldpulse_job_id" IS 'Fieldpulse job ID for status sync';
