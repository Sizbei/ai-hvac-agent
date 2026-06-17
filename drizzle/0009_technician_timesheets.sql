CREATE TABLE "technician_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"clock_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_out_at" timestamp with time zone,
	"minutes" integer,
	"labor_rate_cents" integer DEFAULT 0 NOT NULL,
	"labor_cost_cents" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "labor_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD CONSTRAINT "technician_time_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD CONSTRAINT "technician_time_entries_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD CONSTRAINT "technician_time_entries_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tte_org_idx" ON "technician_time_entries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tte_request_idx" ON "technician_time_entries" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tte_open_per_tech_job_unique" ON "technician_time_entries" USING btree ("service_request_id","technician_id") WHERE "technician_time_entries"."clock_out_at" IS NULL;