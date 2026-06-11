-- Ghost CSR: Communication Automation Foundation
-- Adds tables for automated customer communication (templates, jobs, preferences)

-- Communication channel types
CREATE TYPE "communication_channel" AS ENUM ('sms', 'email', 'voice');

-- Message/trigger types (events that can initiate a communication)
CREATE TYPE "communication_trigger_type" AS ENUM (
  'appointment_scheduled',
  'appointment_reminder_24h',
  'appointment_reminder_2h',
  'appointment_rescheduled',
  'appointment_cancelled',
  'technician_enroute',
  'technician_arrived',
  'job_completed',
  'review_request',
  'follow_up',
  'escalation'
);

-- Job execution status
CREATE TYPE "communication_job_status" AS ENUM (
  'pending',
  'processing',
  'sent',
  'failed',
  'cancelled'
);

-- Template types (determines rendering engine)
CREATE TYPE "communication_template_type" AS ENUM ('sms', 'email_html', 'email_text');

-- Communication templates per organization
CREATE TABLE "communication_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "key" varchar(100) NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "trigger_type" "communication_trigger_type" NOT NULL,
  "template_type" "communication_template_type" NOT NULL,
  "subject_template" text, -- For email templates
  "body_template" text NOT NULL,
  "variables" jsonb DEFAULT '{}'::jsonb, -- Available variables for template
  "is_active" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 50, -- Lower = higher priority
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "communication_templates_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]*$')
);

-- Indexes for template lookups
CREATE INDEX "communication_templates_org_id_idx" ON "communication_templates"("organization_id");
CREATE INDEX "communication_templates_org_trigger_active_idx" ON "communication_templates"("organization_id", "trigger_type", "is_active");
CREATE UNIQUE INDEX "communication_templates_org_key_unique" ON "communication_templates"("organization_id", "key");

-- Communication jobs queue
CREATE TABLE "communication_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "template_id" uuid NOT NULL REFERENCES "communication_templates"("id") ON DELETE CASCADE,
  "trigger_type" "communication_trigger_type" NOT NULL,
  "channel" "communication_channel" NOT NULL,
  "status" "communication_job_status" NOT NULL DEFAULT 'pending',
  "priority" integer NOT NULL DEFAULT 50,

  -- Recipient information
  "recipient_phone" varchar(20),
  "recipient_email" text,

  -- Context data for template rendering
  "template_variables" jsonb DEFAULT '{}'::jsonb,

  -- Execution tracking
  "scheduled_for" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "error_message" text,

  -- External IDs (provider message IDs)
  "external_id" varchar(255),

  -- Related entities
  "customer_id" uuid,
  "service_request_id" uuid,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for job processing
CREATE INDEX "communication_jobs_org_id_idx" ON "communication_jobs"("organization_id");
CREATE INDEX "communication_jobs_status_scheduled_idx" ON "communication_jobs"("status", "scheduled_for") WHERE "status" IN ('pending', 'failed');
CREATE INDEX "communication_jobs_service_request_idx" ON "communication_jobs"("service_request_id");
CREATE INDEX "communication_jobs_customer_idx" ON "communication_jobs"("customer_id");
CREATE INDEX "communication_jobs_external_id_idx" ON "communication_jobs"("external_id");

-- Customer communication preferences
CREATE TABLE "communication_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL,

  -- Channel preferences
  "sms_enabled" boolean NOT NULL DEFAULT true,
  "email_enabled" boolean NOT NULL DEFAULT true,
  "voice_enabled" boolean NOT NULL DEFAULT false,

  -- Specific preferences
  "appointment_reminders" boolean NOT NULL DEFAULT true,
  "automated_confirmations" boolean NOT NULL DEFAULT true,
  "review_requests" boolean NOT NULL DEFAULT true,
  "marketing_messages" boolean NOT NULL DEFAULT false,

  -- Timezone for scheduling
  "timezone" varchar(50) DEFAULT 'America/New_York',

  -- Do not contact flag
  "do_not_contact" boolean NOT NULL DEFAULT false,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for preference lookups
CREATE INDEX "communication_prefs_org_id_idx" ON "communication_preferences"("organization_id");
CREATE UNIQUE INDEX "communication_prefs_org_customer_unique" ON "communication_preferences"("organization_id", "customer_id");

-- Comments for documentation
COMMENT ON TABLE "communication_templates" IS 'Reusable message templates for automated customer communications';
COMMENT ON TABLE "communication_jobs" IS 'Queue of pending/completed communication jobs with execution status';
COMMENT ON TABLE "communication_preferences" IS 'Per-customer communication preferences and opt-out settings';
COMMENT ON COLUMN "communication_templates"."key" IS 'Machine-readable template identifier (snake_case)';
COMMENT ON COLUMN "communication_jobs"."scheduled_for" IS 'When this job should be executed (can be immediate or delayed)';
COMMENT ON COLUMN "communication_jobs"."external_id" IS 'Provider-specific message ID (e.g., Twilio message SID, SendGrid message ID)';
COMMENT ON COLUMN "communication_preferences"."do_not_contact" IS 'Global opt-out; if true, suppress all non-essential communications';
