ALTER TYPE "public"."org_status" ADD VALUE 'past_due';--> statement-breakpoint
CREATE TABLE "saas_billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_billing_events" ADD CONSTRAINT "saas_billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_billing_events_event_id_unique" ON "saas_billing_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "saas_billing_events_org_id_idx" ON "saas_billing_events" USING btree ("organization_id");