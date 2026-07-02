CREATE TABLE "technician_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"service_request_id" uuid,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_m" double precision,
	"heading" double precision,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "scheduling_source" text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "dispatch_alert_phone" text;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "estimated_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "estimated_duration_source" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "auto_dispatch_outcome" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_base_lat" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_base_lng" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "location_sharing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "location_consent_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tloc_org_idx" ON "technician_locations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tloc_latest_idx" ON "technician_locations" USING btree ("organization_id","technician_id","captured_at");--> statement-breakpoint
CREATE INDEX "tloc_captured_idx" ON "technician_locations" USING btree ("captured_at");