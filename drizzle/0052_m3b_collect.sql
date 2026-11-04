-- M3b Collect: payment method + manual-payment attribution, invoice signature
-- snapshot + pay-link cooldown, one native draft per request, idempotency keys,
-- invoice_sent trigger. Idempotent throughout (one DO block per constraint).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "method" text DEFAULT 'card' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "check_number" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "recorded_by" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_method_check" CHECK ("payments"."method" IN ('card','cash','check','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_check_number_check" CHECK ("payments"."check_number" IS NULL OR "payments"."method" = 'check');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "pay_link_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "signature_url" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "signature_name" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "signed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_one_native_draft_per_request_idx" ON "invoices" USING btree ("service_request_id") WHERE "invoices"."service_request_id" IS NOT NULL AND "invoices"."state" = 'draft' AND "invoices"."fieldpulse_invoice_id" IS NULL AND "invoices"."hcp_invoice_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "job_material_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_job_material_id_job_materials_id_fk" FOREIGN KEY ("job_material_id") REFERENCES "public"."job_materials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"attempt_id" uuid NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("organization_id","user_id","route","key"),
	CONSTRAINT "idempotency_keys_state_check" CHECK ("idempotency_keys"."state" IN ('in_progress','done'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");
--> statement-breakpoint
-- Last: nothing in this file uses the new value.
ALTER TYPE "public"."communication_trigger_type" ADD VALUE IF NOT EXISTS 'invoice_sent';
