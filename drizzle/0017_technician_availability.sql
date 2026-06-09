-- Technician working hours (the scheduling foundation).
--
-- One row per technician per weekday SHIFT: dayOfWeek (0=Sunday … 6=Saturday)
-- and a [startMinute, endMinute) span measured in minutes from midnight in the
-- BUSINESS timezone (America/New_York), NOT UTC — these describe a recurring
-- weekly pattern ("Mon 8:00am–5:00pm"), so they're anchored to wall-clock
-- business hours, and the calendar layer resolves them against a concrete date
-- (handling DST) when it needs UTC instants. Multiple rows per tech/day are
-- allowed so split shifts (e.g. 8–12 and 13–17) are just two rows.
--
-- This is the NATIVE source of availability today; an HCP-backed source can
-- replace it later behind the scheduling-source seam without schema changes.
--
-- Plain CREATE TABLE + indexes — no enum / ALTER TYPE, so no in-transaction
-- hazard; runs fine through the standard neon-http file migrator.
CREATE TABLE "technician_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tech_availability_org_id_idx" ON "technician_availability" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tech_availability_org_tech_idx" ON "technician_availability" USING btree ("organization_id","technician_id");--> statement-breakpoint
CREATE INDEX "tech_availability_org_tech_day_idx" ON "technician_availability" USING btree ("organization_id","technician_id","day_of_week");
