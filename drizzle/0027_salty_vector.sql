CREATE TABLE "dispatch_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"chosen_technician_id" uuid,
	"top_score" double precision,
	"confidence_gap" double precision,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_chosen_technician_id_users_id_fk" FOREIGN KEY ("chosen_technician_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_decisions_org_idx" ON "dispatch_decisions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dispatch_decisions_request_idx" ON "dispatch_decisions" USING btree ("service_request_id");