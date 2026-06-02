-- Phase 1: per-org chatbot configuration (additive — two new tables only).
CREATE TABLE IF NOT EXISTS "custom_faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"company_name" text,
	"logo_url" text,
	"primary_color" varchar(9),
	"welcome_message" text,
	"launcher_position" text,
	"disabled_issue_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_service_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "custom_faqs" ADD CONSTRAINT "custom_faqs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_faqs_org_id_idx" ON "custom_faqs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_faqs_org_active_idx" ON "custom_faqs" USING btree ("organization_id","is_active");
