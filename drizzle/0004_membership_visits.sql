CREATE TYPE "public"."membership_visit_status" AS ENUM('scheduled', 'generated', 'completed', 'skipped');--> statement-breakpoint
CREATE TABLE "membership_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_membership_id" uuid NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"period_key" text NOT NULL,
	"status" "membership_visit_status" DEFAULT 'scheduled' NOT NULL,
	"generated_service_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "visits_per_year" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "benefits" jsonb;--> statement-breakpoint
ALTER TABLE "membership_visits" ADD CONSTRAINT "membership_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_visits" ADD CONSTRAINT "membership_visits_customer_membership_id_customer_memberships_id_fk" FOREIGN KEY ("customer_membership_id") REFERENCES "public"."customer_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_visits" ADD CONSTRAINT "membership_visits_generated_service_request_id_service_requests_id_fk" FOREIGN KEY ("generated_service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_visits_org_idx" ON "membership_visits" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "membership_visits_membership_idx" ON "membership_visits" USING btree ("customer_membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_visits_membership_period_unique" ON "membership_visits" USING btree ("customer_membership_id","period_key");