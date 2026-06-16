-- Stage 1: Compliance & Eventing Foundation.

-- actorType: who/what performed an action (human | ai | system).
CREATE TYPE "actor_type" AS ENUM ('human', 'ai', 'system');

-- audit_log gains actor_type (defaults human; existing rows are human actions).
ALTER TABLE "audit_log" ADD COLUMN "actor_type" "actor_type" NOT NULL DEFAULT 'human';

-- Outbound dedupe ledger for cron-driven customer messaging.
CREATE TABLE "outbound_message_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "trigger_type" "communication_trigger_type" NOT NULL,
  "period_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "outbound_ledger_unique"
  ON "outbound_message_ledger" ("organization_id", "customer_id", "trigger_type", "period_key");

-- Append-only service-request status transition log.
CREATE TABLE "request_status_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "service_request_id" uuid NOT NULL REFERENCES "service_requests"("id") ON DELETE cascade,
  "from_status" "request_status",
  "to_status" "request_status" NOT NULL,
  "actor_type" "actor_type" NOT NULL DEFAULT 'system',
  "actor_id" uuid,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "request_status_events_request_idx" ON "request_status_events" ("service_request_id");
CREATE INDEX "request_status_events_org_idx" ON "request_status_events" ("organization_id");
